/**
 * daily-log-tool.ts — Daily Log tool for pi-hindsight.
 *
 * Provides:
 * - `mem_daily` tool: manually append daily log entries
 * - `/mem-daily` command: view today's log
 * - Auto-append on session_shutdown: "Session handoff: [n] turns, [m] memories"
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DailyLogParams = Type.Object({
  content: Type.String({ description: "日志内容（Markdown 格式）" }),
});

export function registerDailyLogTool(pi: ExtensionAPI, store: MemoryStore): void {
  // ——————————————————————
  // mem_daily tool
  // ——————————————————————
  pi.registerTool({
    name: "mem_daily",
    label: "Daily Log",
    description:
      "Manually append an entry to today's daily log. " +
      "Daily logs are automatically summarized at session shutdown. " +
      "Example: `mem_daily({content: \"## Progress\\n- Finished auth module\"})`",
    parameters: DailyLogParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const content = params.content as string;
      if (!content.trim()) {
        return { content: [{ type: "text" as const, text: "Error: `content` is required." }], isError: true };
      }

      const row = store.dailyLogAppend(today(), content, "manual");
      return {
        content: [
          { type: "text" as const, text: `📝 Daily log entry added (id=${row.id}). Use \`/mem-daily\` to view today's log.` },
        ],
        details: { id: row.id, date: row.date },
      };
    },
  });

  // ——————————————————————
  // /mem-daily command
  // ——————————————————————
  pi.registerCommand("mem-daily", {
    description: "Show today's daily log entries",
    handler: async (args, ctx) => {
      const date = args.trim() || today();
      const entries = store.getDailyLogsByDate(date);
      if (entries.length === 0) {
        ctx.ui.notify(`📭 No daily log entries for ${date}.`, "info");
        return;
      }

      const lines = entries.map((e, i) => {
        return `[${new Date(e.createdAt).toLocaleTimeString()}] (${e.entryType})\n${e.content}`;
      });

      ctx.ui.notify(
        `📋 Daily Log — ${date}\n\n${lines.join("\n\n---\n\n")}`,
        "info",
      );
    },
  });
}

/** Register the auto-append handler on session_shutdown. */
export function registerDailyLogAutoAppend(pi: ExtensionAPI, store: MemoryStore): void {
  pi.on("session_shutdown", async () => {
    // Count recent memories for this project
    const count = store.count();
    const openSp = store.openScratchpadCount();

    const content = `Session handoff: ${count.total} memories captured, ${openSp} open scratchpad items.`;
    store.dailyLogAppend(today(), content, "auto");
    console.debug(`[pi-hindsight] session_shutdown: daily log auto-appended`);
  });
}