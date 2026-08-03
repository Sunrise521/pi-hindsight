/**
 * scratchpad.ts — scratch tool for todo list management.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

const ScratchParams = Type.Object({
  action: Type.String({ description: "操作: add | list | done | clear | undo" }),
  label: Type.Optional(Type.String({ description: "待办描述（action=add 时必填）" })),
  id: Type.Optional(Type.Number({ description: "待办 ID（action=done|undo 时必填）" })),
  priority: Type.Optional(Type.Number({ description: "优先级 0=low, 1=normal, 2=high（默认 1）" })),
  status: Type.Optional(Type.String({ description: "筛选状态: open | done（action=list 时可选）" })),
});

export function registerScratchpad(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerTool({
    name: "scratch",
    label: "Scratchpad",
    description:
      "Manage a project-scoped todo list (scratchpad). " +
      "Actions: `add` (add a new todo), `list` (list todos), " +
      "`done` (mark as done), `undo` (mark as cancelled), " +
      "`clear` (clear done/cancelled items). " +
      'Example: `scratch({action: "add", label: "fix auth", priority: 2})`',
    parameters: ScratchParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const action = params.action as string;
      const label = params.label as string | undefined;
      const id = params.id as number | undefined;
      const priority = (params.priority as number) ?? 1;
      const status = params.status as string | undefined;

      switch (action) {
        case "add": {
          if (!label) {
            return {
              content: [{ type: "text" as const, text: "Error: `label` is required for action=add." }],
              details: {},
              isError: true,
            };
          }
          const row = store.scratchpadAdd(label, priority);
          return {
            content: [{
              type: "text" as const,
              text: `✅ Added scratchpad item #${row.id}: "${label}" (priority: ${priority})`,
            }],
            details: { id: row.id, label, priority, status: "open" },
          };
        }

        case "done": {
          if (id === undefined) {
            return {
              content: [{ type: "text" as const, text: "Error: `id` is required for action=done." }],
              details: {},
              isError: true,
            };
          }
          const ok = store.scratchpadDone(id);
          if (!ok) {
            return {
              content: [{ type: "text" as const, text: `Item #${id} not found or already done.` }],
              details: { id },
            };
          }
          return {
            content: [{ type: "text" as const, text: `✅ Item #${id} marked as done.` }],
            details: { id, action: "done" },
          };
        }

        case "undo": {
          if (id === undefined) {
            return {
              content: [{ type: "text" as const, text: "Error: `id` is required for action=undo." }],
              details: {},
              isError: true,
            };
          }
          const ok = store.scratchpadUndo(id);
          if (!ok) {
            return {
              content: [{ type: "text" as const, text: `Item #${id} not found or already processed.` }],
              details: { id },
            };
          }
          return {
            content: [{ type: "text" as const, text: `↩️ Item #${id} cancelled.` }],
            details: { id, action: "cancelled" },
          };
        }

        case "list": {
          const items = store.scratchpadList(status as "open" | "done" | "cancelled" | undefined);
          if (items.length === 0) {
            const filterText = status ? ` (${status})` : "";
            return {
              content: [{ type: "text" as const, text: `No scratchpad items${filterText}.` }],
              details: { total: 0, status: status ?? "all" },
            };
          }
          const lines = items.map((s, i) => {
            const statusIcon = s.status === "open" ? "⬜" : s.status === "done" ? "✅" : "↩️";
            return `${i + 1}. ${statusIcon} [#${s.id}] (p${s.priority}) ${s.label}`;
          });
          return {
            content: [{
              type: "text" as const,
              text: `Scratchpad (${items.length} items):\n${lines.join("\n")}`,
            }],
            details: { total: items.length, items: items.map(s => ({ id: s.id, label: s.label, status: s.status, priority: s.priority })) },
          };
        }

        case "clear": {
          const target = (status as "done" | "cancelled") ?? "done";
          const count = store.scratchpadClear(target);
          return {
            content: [{ type: "text" as const, text: `🧹 Cleared ${count} ${target} items.` }],
            details: { cleared: count, status: target },
          };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: "${action}". Use: add, list, done, undo, clear.` }],
            details: {},
            isError: true,
          };
      }
    },
  });
}
