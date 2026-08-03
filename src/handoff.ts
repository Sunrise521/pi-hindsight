/**
 * handoff.ts — Session handoff handler for pi-hindsight.
 *
 * Listens on `session_before_compact` to write a handoff summary
 * to the daily_logs table, providing session continuity.
 *
 * Format:
 * ## Session Handoff YYYY-MM-DD HH:MM
 * - Open scratchpad: [n] items
 * - 新增记忆: [n] (decisions, facts, changes, ...)
 * - 重要决策: "..."
 */
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

function now(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function registerHandoff(pi: ExtensionAPI, store: MemoryStore): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx): Promise<SessionBeforeCompactResult | void> => {
    // Count memories by category
    const count = store.count();
    const catSummary = Object.entries(count.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `${n} ${cat}`)
      .join(", ");

    // Get open scratchpad items
    const openSp = store.getOpenScratchpadItems(5);

    // Get top high-importance decisions
    const topDecisions = store.recall("", {
      category: "decision",
      limit: 3,
      mode: "fts",
    });

    const lines: string[] = [];
    lines.push(`## Session Handoff ${now()}`);
    lines.push("");
    lines.push(`- Open scratchpad: ${openSp.length} items`);
    if (openSp.length > 0) {
      for (const sp of openSp) {
        lines.push(`  - ${sp.label}`);
      }
    }
    lines.push(`- 新增记忆: ${count.total} (${catSummary || "none"})`);
    if (topDecisions.hits.length > 0) {
      lines.push(`- 重要决策:`);
      for (const h of topDecisions.hits) {
        lines.push(`  - ${h.summary.slice(0, 120)}`);
      }
    }
    lines.push("");

    const content = lines.join("\n");
    store.dailyLogAppend(today(), content, "auto");
    console.debug(`[pi-hindsight] handoff written to daily_logs`);
  });
}