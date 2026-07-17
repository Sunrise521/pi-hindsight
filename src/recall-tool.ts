/**
 * recall-tool.ts — reg_memory / recall_memory tool for pi.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

const RecallParams = Type.Object({
  query: Type.String({ description: "关键词查询（FTS5 语法，如 'auth OR jwt'）" }),
  category: Type.Optional(Type.String({
    description: "过滤类别: decision|fact|preference|change|error|task|constraint",
  })),
  limit: Type.Optional(Type.Number({ description: "最大返回条数（默认 10，最大 30）" })),
  mode: Type.Optional(Type.String({
    description: "召回模式: fts（关键词）| vector（语义）| hybrid（混合）",
  })),
});

const CountParams = Type.Object({
  category: Type.Optional(Type.String({
    description: "按类别过滤计数",
  })),
});

export function registerRecallTool(pi: ExtensionAPI, store: MemoryStore): void {
  // ——————————————————————
  // recall_memory
  // ——————————————————————
  pi.registerTool({
    name: "recall_memory",
    label: "Recall Memory",
    description:
      "Recall past decisions, facts, code changes from Hindsight memory. " +
      "Uses FTS5 keyword search + optional vector ANN. " +
      "Example: `recall_memory({query: 'auth JWT', mode: 'hybrid', limit: 5})`. " +
      "Returns scored hits with summary and category.",
    parameters: RecallParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const query = params.query as string;
      const category = params.category as string | undefined;
      const limit = Math.min((params.limit as number) ?? 10, 30);
      const mode = (params.mode as string) ?? "fts";

      const result = store.recall(query, {
        category,
        limit,
        mode: mode as "fts" | "vector" | "hybrid",
      });

      if (result.hits.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching memories found." }],
          details: { total: 0, mode: result.mode },
        };
      }

      const lines = result.hits.map((h, i) => {
        return `${i + 1}. [${h.category}] (score: ${h.score.toFixed(3)}) ${h.summary}`;
      });

      const text = [
        `Found ${result.total} memories (mode: ${result.mode}, showing top ${result.hits.length}):`,
        "",
        ...lines,
        "",
        `Tip: use \`category\` filter or \`mode: "vector"\` / \`mode: "hybrid"\` for different precision.`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          total: result.total,
          hits: result.hits.length,
          mode: result.mode,
          categories: [...new Set(result.hits.map((h) => h.category))],
        },
      };
    },
  });

  // ——————————————————————
  // mem_count — lightweight introspection
  // ——————————————————————
  pi.registerTool({
    name: "mem_count",
    label: "Memory Count",
    description: "Count stored memories, optionally by category.",
    parameters: CountParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const category = params.category as string | undefined;

      let text: string;
      if (category) {
        const rows = (store as any).db.prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE project_key = ? AND category = ?",
        ).get(store.projectKey, category) as { c: number };
        text = `Category "${category}": ${rows.c} memories`;
      } else {
        const info = store.count();
        const cats = Object.entries(info.byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, count]) => `  ${cat}: ${count}`)
          .join("\n");
        text = `Total: ${info.total} memories\nBy category:\n${cats}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  });

  // ——————————————————————
  // mem_status — extension health check
  // ——————————————————————
  pi.registerCommand("mem-status", {
    description: "Show Hindsight extension status",
    handler: async (args, ctx) => {
      const info = store.count();
      const vecStatus = store.vecAvailable ? "✅ sqlite-vec loaded" : "❌ sqlite-vec not available";
      const lines = [
        `📊 Hindsight Memory Status`,
        `   Project: ${store.projectKey.slice(0, 16)}…`,
        `   Database: ${store.dbPath}`,
        `   Vector: ${vecStatus}`,
        `   Total memories: ${info.total}`,
        `   By category:`,
        ...Object.entries(info.byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, count]) => `     ${cat}: ${count}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
