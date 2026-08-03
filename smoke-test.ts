import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./src/memory-store.js";

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-hindsight-smoke-"));
  const dbPath = join(tmpDir, "smoke.db");
  console.log(`[smoke] DB: ${dbPath}`);

  const store = new MemoryStore(dbPath, "smoke-test-project");

  // 1. Write a memory
  const row = store.store({
    summary: "smoke test memory - auth uses JWT HS256",
    detail: "test detail",
    category: "decision",
    importance: 0.5,
  });
  console.log(`[smoke] Written id=${row.id}, cat=${row.category}`);
  if (!row.id) throw new Error("FAIL: no id");

  // 2. Recall before archive
  const r1 = store.recall("smoke test memory", { mode: "fts" });
  console.log(`[smoke] Recall before: ${r1.hits.length} hits`);
  if (!r1.hits.some((h) => h.id === row.id))
    throw new Error("FAIL: not found before archive");
  console.log(`[smoke] ✅ Found memory #${row.id}`);

  // 3. Archive
  try {
    const ok = store.archiveMemory(row.id);
    console.log(`[smoke] 🔄 archiveMemory result: ${ok}`);
    if (!ok)
      throw new Error("FAIL: archiveMemory returned false");
    console.log(`[smoke] ✅ Archived memory #${row.id}`);
  } catch (e: any) {
    console.error(`[smoke] ❌ archiveMemory threw: ${e.message}`);
    throw e;
  }

  // 4. Recall after archive — must NOT find it
  const r2 = store.recall("smoke test memory", { mode: "fts" });
  console.log(`[smoke] Recall after: ${r2.hits.length} hits`);
  if (r2.hits.some((h) => h.id === row.id))
    throw new Error("FAIL: still found after archive — status filter broken");
  console.log(`[smoke] ✅ Archived memory excluded (filter works)`);

  // 5. archiveMemory on non-existent id
  try {
    const fakeOk = store.archiveMemory(9999);
    if (fakeOk)
      throw new Error("FAIL: archiveMemory(9999) should return false");
    console.log(`[smoke] ✅ Non-existent returns false`);
  } catch (e: any) {
    if (e.message.includes("returned false"))
      throw e;
    console.error(`[smoke] ❌ archiveMemory(9999) threw: ${e.message}`);
    throw e;
  }

  // Check count
  const count = store.count();
  console.log(`[smoke] Total memories: ${count.total}`);
