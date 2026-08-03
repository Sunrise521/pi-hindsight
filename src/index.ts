/**
 * pi-hindsight — extension entry point.
 *
 * Registers:
 * - `recall_memory` tool (FTS5 + vec0 hybrid recall)
 * - `mem_count` tool (introspection)
 * - `/mem-status` command
 * - tier-1 capture on message_end
 *
 * Db location: ~/.pi/agent/memory/hindsight.db
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { MemoryStore, deriveProjectKey } from "./memory-store.js";
import { registerCapture } from "./capture.js";
import { registerRecallTool } from "./recall-tool.js";
import { registerScratchpad } from "./scratchpad.js";
import { registerHandoff } from "./handoff.js";
import { registerWriteTool } from "./write-tool.js";
// P2 — 待实现:
// import { registerDailyLogTool, registerDailyLogAutoAppend } from "./daily-log-tool.js";
// import { registerExportTool } from "./export-tool.js";
// import { registerInjection } from "./injection.js";

export default async function (pi: ExtensionAPI) {
  // Resolve db path
  const memoryDir = join(homedir(), ".pi", "agent", "memory");
  const dbPath = join(memoryDir, "hindsight.db");

  // Derive project key from cwd (available via ctx in handlers)
  // We store it per MemoryStore instance; tier-2 can override via env
  const projectKey = deriveProjectKey(process.cwd());

  // Initialize store
  const store = new MemoryStore(dbPath, projectKey);

  console.log(
    `[pi-hindsight] loaded (project=${projectKey.slice(0, 16)}…, db=${dbPath}, vec=${store.vecAvailable})`,
  );

  // Register tools
  registerRecallTool(pi, store);
  registerWriteTool(pi, store);
  registerScratchpad(pi, store);
  // P2: registerDailyLogTool(pi, store);
  // P2: registerExportTool(pi, store);

  // Register tier-1 capture
  registerCapture(pi, store);

  // Register session shutdown to run decay
  pi.on("session_shutdown", async () => {
    const archived = store.runDecay();
    if (archived > 0) {
      console.debug(`[pi-hindsight] decay archived ${archived} memories`);
    }
  });
  // P2: registerDailyLogAutoAppend(pi, store);

  // Register session handoff on compact
  registerHandoff(pi, store);

  // P2: registerInjection(pi, store); — 需 PI_MEM_AMBIENT=1 + before_agent_start handler + KV-cache snapshot
}
