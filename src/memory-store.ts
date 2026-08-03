/**
 * MemoryStore — better-sqlite3 + FTS5 + sqlite-vec storage layer.
 *
 * - Schema with project isolation, FTS5 via triggers, vec0 table.
 * - WAL journal for concurrent-safety.
 * - content_hash based upsert for tier-1 dedup.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createEmbedder, VECTOR_DIM, type Embedder } from "./embed.js";
import { homedir, hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export { VECTOR_DIM } from "./embed.js";

export interface DraftMemory {
  summary: string;
  detail?: string;
  category: "decision" | "fact" | "preference" | "change" | "error" | "task" | "constraint";
  importance?: number;
  sessionId?: string;
  turnIndex?: number;
  tags?: string;
}

export interface ScratchpadRow {
  id: number;
  projectKey: string;
  sessionId: string | null;
  label: string;
  priority: number;
  status: "open" | "done" | "cancelled";
  createdAt: number;
  doneAt: number | null;
  updatedAt: number;
}

export interface DailyLogRow {
  id: number;
  projectKey: string;
  date: string;
  content: string;
  entryType: string;
  createdAt: number;
}

export interface MemoryRow {
  id: number;
  projectKey: string;
  sessionId: string | null;
  turnIndex: number | null;
  category: string;
  summary: string;
  detail: string | null;
  tags: string | null;
  contentHash: string;
  importance: number;
  confidence: number;
  accessCnt: number;
  status: string;
  createdAt: number;
  updatedAt: number;
  accessedAt: number | null;
}

export interface RecallHit {
  id: number;
  summary: string;
  detail: string | null;
  tags: string | null;
  category: string;
  importance: number;
  confidence: number;
  createdAt: number;
  score: number;
}

export interface RecallResult {
  hits: RecallHit[];
  total: number;
  mode: "fts" | "vector" | "hybrid";
}

// ————————————————————————————————————————————————
// Helpers
// ————————————————————————————————————————————————

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable project key: remote URL > git root > cwd > hash(cwd) — never null. */
export function deriveProjectKey(cwd: string): string {
  // Use env override for testing
  if (process.env.PI_HINDSIGHT_PROJECT) return sha256(process.env.PI_HINDSIGHT_PROJECT);
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const remote = execSync("git remote get-url origin 2>/dev/null", {
      cwd, encoding: "utf8", timeout: 3000,
    }).trim();
    if (remote) return sha256(remote);
  } catch { /* fall through */ }
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = execSync("git rev-parse --show-toplevel 2>/dev/null", {
      cwd, encoding: "utf8", timeout: 3000,
    }).trim();
    if (root) return sha256(root);
  } catch { /* fall through */ }
  return sha256(cwd);
}

function now(): number {
  return Date.now();
}

/** Text fed to the embedder for a memory draft. */
function embedText(m: { summary: string; detail?: string; tags?: string }): string {
  const parts = [m.summary, m.tags ?? ""];
  if (m.detail) parts.push(m.detail);
  return parts.filter(Boolean).join(" ").slice(0, 2000);
}

/**
 * Sanitize a user FTS5 query: quote every bare token as a phrase so tokens
 * can never be parsed as column references or operators (e.g. a query word
 * like "memory" colliding with table columns). Preserves explicit
 * AND/OR/NOT, parentheses and already-quoted phrases.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/"[^"]*"|\(|\)|AND|OR|NOT|\S+/gi) ?? [];
  return tokens
    .map((t) => {
      if (/^".*"$/.test(t) || t === "(" || t === ")") return t;
      if (/^(AND|OR|NOT)$/i.test(t)) return t.toUpperCase();
      return `"${t.replace(/"/g, "")}"`;
    })
    .join(" ");
}

// ————————————————————————————————————————————————
// Store class
// ————————————————————————————————————————————————

export class MemoryStore {
  private db: Database.Database;
  public readonly projectKey: string;
  public readonly dbPath: string;
  public vecAvailable = false;
  public readonly embedder: Embedder;

  constructor(dbPath: string, projectKey: string, embedder?: Embedder) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.projectKey = projectKey;
    this.embedder = embedder ?? createEmbedder();
    this.db = new Database(dbPath);

    // Load sqlite-vec (optional — degrade gracefully)
    try {
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch {
      console.warn("[pi-hindsight] sqlite-vec not available, vector search disabled");
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
  }

  // ——————————————————————————
  // Schema
  // ——————————————————————————

  private initSchema(): void {
    // Core memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY,
        project_key  TEXT NOT NULL,
        session_id   TEXT,
        turn_index   INTEGER,
        category     TEXT NOT NULL CHECK (category IN (
          'decision','fact','preference','change','error','task','constraint'
        )),
        summary      TEXT NOT NULL,
        detail       TEXT,
        tags         TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        importance   REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
        confidence   REAL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
        access_cnt   INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','curated','archived','conflict')),
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        accessed_at  INTEGER
      );
    `);

    // FTS5 table — standalone (not external content) for simplicity and reliability
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(summary, detail, tags, tokenize='unicode61');
    `);

    // FTS5 sync triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, detail, tags)
        VALUES (new.id, new.summary, new.detail, new.tags);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad
      AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au
      AFTER UPDATE ON memories BEGIN
        UPDATE memories_fts SET summary = new.summary, detail = new.detail, tags = new.tags WHERE rowid = new.id;
      END;
    `);

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_proj_cat
      ON memories(project_key, category, importance DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mem_created
      ON memories(project_key, created_at DESC);
    `);

    // vec0 table (only if sqlite-vec loaded)
    if (this.vecAvailable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
        USING vec0(embedding float[${VECTOR_DIM}]);
      `);
    }

    // scratchpad table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scratchpad (
        id          INTEGER PRIMARY KEY,
        project_key TEXT NOT NULL,
        session_id  TEXT,
        label       TEXT NOT NULL,
        priority    INTEGER DEFAULT 1,
        status      TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','done','cancelled')),
        created_at  INTEGER NOT NULL,
        done_at     INTEGER,
        updated_at  INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sp_proj_status
      ON scratchpad(project_key, status, priority DESC);
    `);

    // daily_logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_logs (
        id          INTEGER PRIMARY KEY,
        project_key TEXT NOT NULL,
        date        TEXT NOT NULL,
        content     TEXT NOT NULL,
        entry_type  TEXT DEFAULT 'auto',
        created_at  INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dl_date
      ON daily_logs(project_key, date, created_at);
    `);

    // config table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ——————————————————————————
  // Write
  // ——————————————————————————

  /** Store a memory with content_hash dedup (upsert). */
  store(m: DraftMemory, opts?: { vector?: number[] }): MemoryRow {
    const now_ = now();
    const hash = sha256(m.summary + (m.detail ?? ""));

    const stmt = this.db.prepare(`
      INSERT INTO memories
        (project_key, session_id, turn_index, category, summary, detail,
         tags, content_hash, importance, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET
        access_cnt  = access_cnt + 1,
        importance  = MAX(importance, excluded.importance),
        updated_at  = excluded.updated_at,
        accessed_at = excluded.updated_at;
    `);

    const info = stmt.run(
      this.projectKey,
      m.sessionId ?? null,
      m.turnIndex ?? null,
      m.category,
      m.summary,
      m.detail ?? null,
      m.tags ?? null,
      hash,
      m.importance ?? 0.3,
      m.importance ? 0.7 : 0.4,
      now_,
      now_,
    );
    const rowId = Number(info.lastInsertRowid);

    // Vector write — only on first insert (content_hash dedup keeps the id
    // stable across upserts, so an existing id already has its vector).
    if (info.changes === 1 && this.vecAvailable) {
      const vec =
        opts?.vector ??
        (this.embedder.embedSync ? this.embedder.embedSync([embedText(m)])[0] : undefined);
      if (vec) {
        try {
          this.db
            .prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)")
            .run(BigInt(rowId), JSON.stringify(vec));
        } catch (e) {
          console.warn(`[pi-hindsight] vec insert failed: ${(e as Error).message}`);
        }
      }
    }

    return this.getById(rowId)!;
  }

  /** Batch store multiple memories (transactional). Embeds before the sync tx. */
  async storeBatch(mems: DraftMemory[]): Promise<number> {
    if (mems.length === 0) return 0;
    const texts = mems.map(embedText);
    const vectors = this.embedder.embedSync
      ? this.embedder.embedSync(texts)
      : await this.embedder.embed(texts);
    const insert = this.db.transaction((items: Array<{ m: DraftMemory; vec: number[] }>) => {
      for (const it of items) this.store(it.m, { vector: it.vec });
      return items.length;
    });
    return insert(mems.map((m, i) => ({ m, vec: vectors[i] })));
  }

  // ——————————————————————————
  // Read
  // ——————————————————————————

  getById(id: number): MemoryRow | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  // ——————————————————————————
  // Recall (FTS5 + optional vector)
  // ——————————————————————————

  /**
   * Hybrid recall: FTS5 keyword search + optional vector ANN.
   * Returns RRF-fused top-K results.
   */
  async recall(
    query: string,
    opts: {
      category?: string;
      projectKey?: string;
      limit?: number;
      mode?: "fts" | "vector" | "hybrid";
    } = {},
  ): Promise<RecallResult> {
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? "fts";
    const pk = opts.projectKey ?? this.projectKey;

    if (!query.trim()) return { hits: [], total: 0, mode };

    const safeQuery = sanitizeFtsQuery(query);

    // FTS5 score (normalized BM25)
    let ftsHits: Array<{ id: number; score: number }> = [];
    if (mode === "fts" || mode === "hybrid") {
      const sql = `
        SELECT m.id AS id, bm25(memories_fts, 0.0, 1.0) AS bm25
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND m.project_key = ?

          AND m.status != 'archived'
          ${opts.category ? "AND m.category = ?" : ""}
        ORDER BY bm25
        LIMIT ${limit * 2}
      `;
      const params: unknown[] = [safeQuery, pk];
      if (opts.category) params.push(opts.category);
      ftsHits = (this.db.prepare(sql).all(...params) as Array<{ id: number; bm25: number }>).map(r => ({
        id: r.id,
        score: 1 / (1 + r.bm25), // normalize so higher = better, range ~0-1
      }));
    }

    // Vector score — real kNN: embed the query, then MATCH + k against vec0
    let vecHits: Array<{ id: number; score: number }> = [];
    if (mode !== "fts" && this.vecAvailable) {
      try {
        const qvec = this.embedder.embedSync
          ? this.embedder.embedSync([query])[0]
          : (await this.embedder.embed([query]))[0];
        const k = Math.max(limit * 4, 40);
        const sql = `
          SELECT v.rowid AS id, v.distance AS d
          FROM memories_vec v
          JOIN memories m ON m.id = v.rowid
          WHERE v.embedding MATCH ? AND v.k = ?
            AND m.project_key = ?
            AND m.status != 'archived'
            ${opts.category ? "AND m.category = ?" : ""}
        `;
        const params: unknown[] = [JSON.stringify(qvec), k, pk];
        if (opts.category) params.push(opts.category);
        vecHits = (this.db.prepare(sql).all(...params) as Array<{ id: number; d: number }>).map(r => ({
          id: r.id,
          score: 1 / (1 + r.d),
        }));
      } catch {
        // vec table empty or embedding failed; degrade gracefully
        vecHits = [];
      }
    }

    // RRF fusion
    if (mode === "hybrid" && ftsHits.length > 0 && vecHits.length > 0) {
      const merged = new Map<number, { fts: number; vec: number }>();
      for (const h of ftsHits) merged.set(h.id, { fts: h.score, vec: 0 });
      for (const h of vecHits) {
        const existing = merged.get(h.id);
        if (existing) existing.vec = h.score;
        else merged.set(h.id, { fts: 0, vec: h.score });
      }

      const fused = Array.from(merged.entries()).map(([id, scores]) => ({
        id,
        score: 0.6 * scores.fts + 0.4 * scores.vec,
      }));
      fused.sort((a, b) => b.score - a.score);

      const top = fused.slice(0, limit);
      const hits = top.map(t => {
        const row = this.getById(t.id);
        return row ? { ...this.rowToRecallHit(row), score: t.score } : null;
      }).filter(Boolean) as RecallHit[];

      return { hits, total: fused.length, mode: "hybrid" };
    }

    // FTS-only or vector-only
    const source = ftsHits.length > 0 ? ftsHits : vecHits;
    source.sort((a, b) => b.score - a.score);
    const top = source.slice(0, limit);
    const hits = top.map(t => {
      const row = this.getById(t.id);
      return row ? { ...this.rowToRecallHit(row), score: t.score } : null;
    }).filter(Boolean) as RecallHit[];

    return { hits, total: source.length, mode: mode === "vector" && !this.vecAvailable ? "fts" : mode };
  }

  // ——————————————————————————
  // Scratchpad
  // ——————————————————————————

  /** Add a scratchpad item. */
  scratchpadAdd(label: string, priority: number, sessionId?: string): ScratchpadRow {
    const now_ = now();
    const id = this.db.prepare(`
      INSERT INTO scratchpad (project_key, session_id, label, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(this.projectKey, sessionId ?? null, label, priority, now_, now_).lastInsertRowid;
    return this.scratchpadGetById(Number(id))!;
  }

  /** Mark a scratchpad item as done. */
  scratchpadDone(id: number): boolean {
    const now_ = now();
    const result = this.db.prepare(`
      UPDATE scratchpad SET status = 'done', done_at = ?, updated_at = ?
      WHERE id = ? AND project_key = ? AND status = 'open'
    `).run(now_, now_, id, this.projectKey);
    return result.changes > 0;
  }

  /** Mark a scratchpad item as cancelled (undo). */
  scratchpadUndo(id: number): boolean {
    const now_ = now();
    const result = this.db.prepare(`
      UPDATE scratchpad SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND project_key = ? AND status = 'open'
    `).run(now_, id, this.projectKey);
    return result.changes > 0;
  }

  /** List scratchpad items, optionally filtered by status. */
  scratchpadList(status?: "open" | "done" | "cancelled"): ScratchpadRow[] {
    let sql = `SELECT * FROM scratchpad WHERE project_key = ?`;
    const params: unknown[] = [this.projectKey];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY priority DESC, created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToScratchpad(r));
  }

  /** Clear scratchpad items by status. */
  scratchpadClear(status: "done" | "cancelled"): number {
    const result = this.db.prepare(`
      DELETE FROM scratchpad WHERE project_key = ? AND status = ?
    `).run(this.projectKey, status);
    return result.changes;
  }

  /** Get open scratchpad items (for injection). */
  getOpenScratchpadItems(limit = 20): ScratchpadRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM scratchpad
      WHERE project_key = ? AND status = 'open'
      ORDER BY priority DESC, created_at DESC
      LIMIT ?
    `).all(this.projectKey, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToScratchpad(r));
  }

  /** Clean up done items older than N days. */
  scratchpadCleanup(days = 7): number {
    const cutoff = now() - days * 86400000;
    const result = this.db.prepare(`
      DELETE FROM scratchpad
      WHERE project_key = ? AND status = 'done' AND done_at < ?
    `).run(this.projectKey, cutoff);
    return result.changes;
  }

  private scratchpadGetById(id: number): ScratchpadRow | null {
    const row = this.db.prepare("SELECT * FROM scratchpad WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToScratchpad(row);
  }

  /** Count open scratchpad items. */
  openScratchpadCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM scratchpad WHERE project_key = ? AND status = 'open'",
    ).get(this.projectKey) as { c: number };
    return row.c;
  }

  // ——————————————————————————
  // Daily Logs
  // ——————————————————————————

  /** Append a daily log entry. */
  dailyLogAppend(date: string, content: string, entryType = "auto"): DailyLogRow {
    const now_ = now();
    const id = this.db.prepare(`
      INSERT INTO daily_logs (project_key, date, content, entry_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.projectKey, date, content, entryType, now_).lastInsertRowid;
    return this.dailyLogGetById(Number(id))!;
  }

  /** Get daily logs for a specific date. */
  getDailyLogsByDate(date: string, limit = 50): DailyLogRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM daily_logs
      WHERE project_key = ? AND date = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(this.projectKey, date, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToDailyLog(r));
  }

  /** Get the most recent daily log entries. */
  getRecentDailyLogs(limit = 10): DailyLogRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM daily_logs
      WHERE project_key = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(this.projectKey, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToDailyLog(r));
  }

  private dailyLogGetById(id: number): DailyLogRow | null {
    const row = this.db.prepare("SELECT * FROM daily_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDailyLog(row);
  }

  // ——————————————————————————
  // Config
  // ——————————————————————————

  configGet(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  configSet(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // ——————————————————————————
  // Curation / decay
  // ——————————————————————————

  /** Run decay: archive low-scoring memories. */
  runDecay(threshold = 0.1, λ = 0.01): number {
    const now_ = now();
    const result = this.db.prepare(`
      UPDATE memories SET status = 'archived', updated_at = ?
      WHERE project_key = ?
        AND status = 'pending'
        AND importance * exp(-? * (? - COALESCE(accessed_at, created_at)) / 86400000)
          < ?
    `).run(now_, this.projectKey, λ, now_, threshold);
    return result.changes;
  }

  /** Archive a single memory by ID (soft delete). Returns true if archived. */
  archiveMemory(id: number): boolean {
    const now_ = now();
    const result = this.db.prepare(
      "UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ? AND project_key = ? AND status != 'archived'",
    ).run(now_, id, this.projectKey);
    return result.changes > 0;
  }

  /** Restore an archived memory by ID. Returns true if restored. */
  restoreMemory(id: number): boolean {
    const now_ = now();
    const result = this.db.prepare(
      "UPDATE memories SET status = 'pending', updated_at = ? WHERE id = ? AND project_key = ? AND status = 'archived'",
    ).run(now_, id, this.projectKey);
    return result.changes > 0;
  }

  /** Recall ONLY archived memories via FTS5 (for restore candidate search). */
  recallArchived(
    query: string,
    opts: { limit?: number } = {},
  ): RecallResult {
    const limit = opts.limit ?? 10;
    if (!query.trim()) return { hits: [], total: 0, mode: "fts" };

    const safeQuery = sanitizeFtsQuery(query);

    const sql = `
      SELECT m.id AS id, bm25(memories_fts, 0.0, 1.0) AS bm25
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.project_key = ?
        AND m.status = 'archived'
      ORDER BY bm25
      LIMIT ${limit}
    `;
    const hits = (this.db.prepare(sql).all(safeQuery, this.projectKey) as Array<{ id: number; bm25: number }>).map(r => ({
      id: r.id,
      score: 1 / (1 + r.bm25),
    }));

    const top = hits.slice(0, limit);
    const resultHits = top.map(t => {
      const row = this.getById(t.id);
      return row ? { ...this.rowToRecallHit(row), score: t.score } : null;
    }).filter(Boolean) as RecallHit[];

    return { hits: resultHits, total: hits.length, mode: "fts" };
  }

  /**
   * Compute the embedding vector for a draft (used by async callers when the
   * embedder has no sync path, e.g. HTTP provider).
   */
  async embedDraft(m: DraftMemory): Promise<number[]> {
    const text = embedText(m);
    return this.embedder.embedSync
      ? this.embedder.embedSync([text])[0]
      : (await this.embedder.embed([text]))[0];
  }

  /** Backfill vectors for memories missing a vec row (idempotent). */
  async backfillVectors(batchSize = 50): Promise<number> {
    if (!this.vecAvailable) return 0;
    let total = 0;
    for (;;) {
      const rows = this.db.prepare(`
        SELECT m.id, m.summary, m.detail, m.tags
        FROM memories m
        LEFT JOIN memories_vec v ON v.rowid = m.id
        WHERE m.project_key = ? AND v.rowid IS NULL
        LIMIT ?
      `).all(this.projectKey, batchSize) as Array<{ id: number; summary: string; detail: string | null; tags: string | null }>;
      if (rows.length === 0) break;
      const texts = rows.map((r) =>
        embedText({ summary: r.summary, detail: r.detail ?? undefined, tags: r.tags ?? undefined }),
      );
      const vectors = this.embedder.embedSync
        ? this.embedder.embedSync(texts)
        : await this.embedder.embed(texts);
      const ins = this.db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");
      const tx = this.db.transaction((items: Array<{ id: number; vec: number[] }>) => {
        for (const it of items) ins.run(BigInt(it.id), JSON.stringify(it.vec));
      });
      tx(rows.map((r, i) => ({ id: r.id, vec: vectors[i] })));
      total += rows.length;
    }
    return total;
  }

  /** Vector coverage for the current project. */
  vectorCoverage(): { total: number; embedded: number } {
    const total = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM memories WHERE project_key = ?",
    ).get(this.projectKey) as { c: number }).c;
    const embedded = (this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM memories m
      JOIN memories_vec v ON v.rowid = m.id
      WHERE m.project_key = ?
    `).get(this.projectKey) as { c: number }).c;
    return { total, embedded };
  }

  // ——————————————————————————
  // Maintenance
  close(): void {
    this.db.close();
  }

  /** Count memories for the current project */
  count(): { total: number; byCategory: Record<string, number> } {
    const total = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM memories WHERE project_key = ?",
    ).get(this.projectKey) as { c: number }).c;

    const rows = this.db.prepare(
      "SELECT category, COUNT(*) AS c FROM memories WHERE project_key = ? GROUP BY category",
    ).all(this.projectKey) as Array<{ category: string; c: number }>;

    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = r.c;
    return { total, byCategory };
  }

  /** Return session memories for tier-2 distillation. */
  getSessionMemories(sessionId: string, limit = 50): MemoryRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE project_key = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(this.projectKey, sessionId, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Return unarchived memories for tier-2 batch processing. */
  getPendingMemories(limit = 100): MemoryRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE project_key = ? AND status IN ('pending','curated')
      ORDER BY importance DESC, created_at ASC
      LIMIT ?
    `).all(this.projectKey, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToMemory(r));
  }

  // ——————————————————————————
  // Internal mappers
  // ——————————————————————————

  private rowToScratchpad(row: Record<string, unknown>): ScratchpadRow {
    return {
      id: row.id as number,
      projectKey: row.project_key as string,
      sessionId: row.session_id as string | null,
      label: row.label as string,
      priority: row.priority as number,
      status: row.status as "open" | "done" | "cancelled",
      createdAt: row.created_at as number,
      doneAt: row.done_at as number | null,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToDailyLog(row: Record<string, unknown>): DailyLogRow {
    return {
      id: row.id as number,
      projectKey: row.project_key as string,
      date: row.date as string,
      content: row.content as string,
      entryType: row.entry_type as string,
      createdAt: row.created_at as number,
    };
  }

  private rowToMemory(row: Record<string, unknown>): MemoryRow {
    return {
      id: row.id as number,
      projectKey: row.project_key as string,
      sessionId: row.session_id as string | null,
      turnIndex: row.turn_index as number | null,
      category: row.category as string,
      summary: row.summary as string,
      detail: row.detail as string | null,
      tags: row.tags as string | null,
      contentHash: row.content_hash as string,
      importance: row.importance as number,
      confidence: row.confidence as number,
      accessCnt: row.access_cnt as number,
      status: row.status as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      accessedAt: row.accessed_at as number | null,
    };
  }

  private rowToRecallHit(row: MemoryRow): RecallHit {
    return {
      id: row.id,
      summary: row.summary,
      detail: row.detail,
      tags: row.tags,
      category: row.category,
      importance: row.importance,
      confidence: row.confidence,
      createdAt: row.createdAt,
      score: 0,
    };
  }
}
