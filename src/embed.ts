/**
 * embed.ts — pluggable embedding providers for the vec0 ANN table.
 *
 * - LocalHashEmbedder (default): deterministic char n-gram feature hashing.
 *   Zero dependencies, offline, instant, always returns VECTOR_DIM floats.
 *   Quality: lexical-overlap similarity (bag-of-n-grams), not neural.
 * - HttpEmbedder: OpenAI-compatible `POST {base}/embeddings` (batch).
 *   Activated via env (see below). Validates dimension; on ANY failure
 *   (network, HTTP status, dim mismatch) falls back to local hashing so
 *   vector recall never breaks.
 *
 * Env:
 *   PI_MEM_EMBED_BASE_URL   — e.g. http://127.0.0.1:4000/v1 (new-api gateway)
 *   PI_MEM_EMBED_API_KEY    — optional bearer token
 *   PI_MEM_EMBED_MODEL      — default "text-embedding-3-small"
 *   PI_MEM_EMBED=local      — force local even if BASE_URL is set
 */

export const VECTOR_DIM = 1536; // fixed dimension — matches existing vec0 tables

export interface Embedder {
  readonly kind: "local" | "http";
  readonly dim: number;
  /** Synchronous path — available for local providers. */
  embedSync?(texts: string[]): number[][];
  /** Always async; local providers resolve immediately. */
  embed(texts: string[]): Promise<number[][]>;
}

// ————————————————————————————————————————————————
// LocalHashEmbedder
// ————————————————————————————————————————————————

/** FNV-1a 32-bit. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Deterministic bag-of-n-grams embedding with sign hashing + L2 norm.
 * 3-4 char grams (code-point based, CJK-friendly) + doubled word tokens.
 */
function hashEmbed(text: string, dim: number): number[] {
  const vec = new Float64Array(dim);
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!norm) return new Array<number>(dim).fill(0);

  const grams: string[] = [];
  const chars = [...norm]; // code points (surrogate-safe)

  for (let n = 3; n <= 4; n++) {
    for (let i = 0; i + n <= chars.length; i++) {
      const g = chars.slice(i, i + n).join("");
      if (!/\s/.test(g)) grams.push(g);
    }
  }
  for (const w of norm.split(/\s+/)) {
    if (w.length >= 2) {
      grams.push("w:" + w);
      grams.push("w:" + w); // double weight for whole words
    }
  }

  for (const g of grams) {
    const h1 = fnv1a(g);
    const h2 = fnv1a(g + "\u0001salt");
    const idx = Math.abs(h1) % dim;
    vec[idx] += (h2 & 1) === 0 ? 1 : -1;
  }

  let len = 0;
  for (let i = 0; i < dim; i++) len += vec[i] * vec[i];
  if (len === 0) return new Array<number>(dim).fill(0);
  const inv = 1 / Math.sqrt(len);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = vec[i] * inv;
  return out;
}

export class LocalHashEmbedder implements Embedder {
  readonly kind = "local" as const;
  constructor(readonly dim: number = VECTOR_DIM) {}

  embedSync(texts: string[]): number[][] {
    return texts.map((t) => hashEmbed(t, this.dim));
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedSync(texts);
  }
}

// ————————————————————————————————————————————————
// HttpEmbedder (OpenAI-compatible /v1/embeddings)
// ————————————————————————————————————————————————

export class HttpEmbedder implements Embedder {
  readonly kind = "http" as const;
  readonly dim: number;
  private fallback: LocalHashEmbedder;
  private warned = false;

  constructor(
    readonly baseUrl: string,
    readonly apiKey: string | undefined,
    readonly model: string,
    dim: number = VECTOR_DIM,
  ) {
    this.dim = dim;
    this.fallback = new LocalHashEmbedder(dim);
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      if (data.data.length !== texts.length) {
        throw new Error(`expected ${texts.length} embeddings, got ${data.data.length}`);
      }
      for (const d of data.data) {
        if (d.embedding.length !== this.dim) {
          throw new Error(`embedding dim ${d.embedding.length} != table dim ${this.dim}`);
        }
      }
      return data.data.map((d) => d.embedding);
    } catch (e) {
      if (!this.warned) {
        console.warn(
          `[pi-hindsight] HTTP embedding failed (${(e as Error).message}), falling back to local hash embedder`,
        );
        this.warned = true;
      }
      return this.fallback.embedSync(texts);
    }
  }
}

// ————————————————————————————————————————————————
// Factory
// ————————————————————————————————————————————————

export function createEmbedder(): Embedder {
  const mode = (process.env.PI_MEM_EMBED ?? "").toLowerCase();
  const base = process.env.PI_MEM_EMBED_BASE_URL;
  if (mode === "http" || (mode !== "local" && base)) {
    return new HttpEmbedder(
      base!,
      process.env.PI_MEM_EMBED_API_KEY,
      process.env.PI_MEM_EMBED_MODEL ?? "text-embedding-3-small",
    );
  }
  return new LocalHashEmbedder();
}
