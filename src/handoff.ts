/**
 * handoff.ts — session_before_compact handoff handler.
 *
 * Writes a handoff summary to daily_logs so compaction doesn't
 * destroy in-progress context. Returns a custom compaction summary.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

export function registerHandoff(pi: ExtensionAPI, store: MemoryStore): void {
  pi.on("session_before_compact", async (event) => {
    // Gather context
    const openItems = store.getOpenScratchpadItems(10);
    const stats = store.count();

    const now = new Date();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = now.toISOString().slice(11, 16);  // HH:MM

    // Build handoff summary
    const lines: string[] = [
      `## Session Handoff ${today} ${time}`,
      "",
    ];

    // Memory stats
    if (stats.total > 0) {
      const cats = Object.entries(stats.byCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `${c}: ${n}`)
        .join(", ");
      lines.push(`- 总记忆: ${stats.total} (${cats})`);
    }

    // Open scratchpad items
    if (openItems.length > 0) {
      lines.push(`- Open scratchpad: ${openItems.length} items`);
      for (const item of openItems) {
        lines.push(`  - [p${item.priority}] ${item.label}`);
      }
    } else {
      lines.push("- Open scratchpad: 0 items");
    }

    lines.push(""); // trailing newline
    const summary = lines.join("\n");

    // Persist to daily_logs
    try {
      store.dailyLogAppend(today, summary, "auto");
    } catch {
      // Non-fatal: handoff is best-effort
    }

    // Return custom compaction summary
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
