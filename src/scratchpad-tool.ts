/**
 * scratchpad-tool.ts — Scratchpad tool for pi-hindsight.
 *
 * Provides `scratch` tool: add/list/done/clear/undo for the todo list.
 * Schema: scratchpad table in memory-store.ts.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

const ScratchParams = Type.Object({
  action: Type.String({
    description: "操作: add | list | done | clear | undo",
  }),
  label: Type.Optional(Type.String({
    description: "待办描述（action=add 时必填）",
  })),
  id: Type.Optional(Type.Number({
    description: "待办 ID（action=done|undo 时必填）",
  })),
  priority: Type.Optional(Type.Number({
    description: "优先级 0=low, 1=normal, 2=high（默认 1）",
  })),
  status: Type.Optional(Type.String({
    description: "筛选状态: open | done | cancelled（action=list 时可选）",
  })),
});

export function registerScratchpadTool(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerTool({
    name: "scratch",
    label: "Scratchpad",
    description:
      "Manage a project-scoped todo list (scratchpad). " +
      "Actions: `add` (add a new todo), `list` (list todos), " +
      "`done` (mark as done), `undo` (mark as cancelled), " +
      "`clear` (clear done/cancelled items). " +
      "Example: `scratch({action: \"add\", label: \"fix auth\", priority: 2})`",
    parameters: ScratchParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const action = params.action as string;

      switch (action) {
        case "add": {
          const label = params.label as string | undefined;
          if (!label) {
            return {
              content: [{ type: "text" as const, text: "Error: `label` is required for action=add." }],
              isError: true,
            };
          }
          const priority = Math.min(Math.max((params.priority as number) ?? 1, 0), 2);
          const item = store.scratchpadAdd(label, priority);
          return {
            content: [{ type: "text" as const, text: `✅ Added scratchpad item #${item.id}: [${priorityStr(item.priority)}] ${item.label}` }],
            details: { id: item.id, label: item.label, priority: item.priority },
          };
        }

        case "done": {
          const id = params.id as number | undefined;
          if (!id) {
            return { content: [{ type: "text" as const, text: "Error: `id` is required for action=done." }], isError: true };
          }
          const ok = store.scratchpadDone(id);
          return {
            content: [{ type: "text" as const, text: ok ? `✅ Scratchpad item #${id} marked done.` : `⚠️ Item #${id} not found or already done.` }],
          };
        }

        case "undo": {
          const id = params.id as number | undefined;
          if (!id) {
            return { content: [{ type: "text" as const, text: "Error: `id` is required for action=undo." }], isError: true };
          }
          const ok = store.scratchpadUndo(id);
          return {
            content: [{ type: "text" as const, text: ok ? `↩️ Scratchpad item #${id} cancelled.` : `⚠️ Item #${id} not found or already done.` }],
          };
        }

        case "list": {
          const status = params.status as "open" | "done" | "cancelled" | undefined;
          const items = store.scratchpadList(status);
          if (items.length === 0) {
            return { content: [{ type: "text" as const, text: "📋 Scratchpad is empty." }] };
          }
          const lines = items.map((item, i) => {
            const statusIcon = item.status === "open" ? "⬜" : item.status === "done" ? "✅" : "❌";
            return `${i + 1}. ${statusIcon} [#${item.id}] ${priorityStr(item.priority)} ${item.label}`;
          });
          return {
            content: [{ type: "text" as const, text: `📋 Scratchpad (${items.length} items):\n\n${lines.join("\n")}` }],
            details: { count: items.length, status: status ?? "all" },
          };
        }

        case "clear": {
          const s = (params.status as string) ?? "done";
          if (s !== "done" && s !== "cancelled") {
            return { content: [{ type: "text" as const, text: "Error: `status` must be 'done' or 'cancelled' for clear." }], isError: true };
          }
          const count = store.scratchpadClear(s);
          return { content: [{ type: "text" as const, text: `🗑️ Cleared ${count} ${s} scratchpad items.` }] };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Error: unknown action "${action}". Use: add, list, done, undo, clear.` }],
            isError: true,
          };
      }
    },
  });
}

function priorityStr(p: number): string {
  if (p === 2) return "🔴";
  if (p === 0) return "🟢";
  return "🟡";
}