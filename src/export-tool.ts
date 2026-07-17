/**
 * export-tool.ts — mem_export tool for pi-hindsight.
 *
 * Exports a readable Markdown view of the memory store, including:
 * - Memories by category
 * - Open scratchpad items
 * - Recent daily logs
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

const ExportParams = Type.Object({
  limit: Type.Optional(Type.Number({
    description: "每类记忆最大条数（默认 20，最大 100）",
  })),
  includeScratchpad: Type.Optional(Type.Boolean({
    description: "是否包含 scratchpad（默认 true）",
  })),
  includeDailyLogs: Type.Optional(Type.Boolean({
    description: "是否包含 daily logs（默认 true）",
  })),
});

export function registerExportTool(pi: ExtensionAPI, store: MemoryStore): void {
  pi.registerTool({
    name: "mem_export",
    label: "Export Memory",
    description:
      "Export a readable Markdown report of the hindsight memory store. " +
      "Includes memories by category, open scratchpad items, and recent daily logs. " +
      "Example: `mem_export({limit: 10, includeScratchpad: true})`",
    parameters: ExportParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const limit = Math.min((params.limit as number) ?? 20, 100);
      const includeSp = (params.includeScratchpad as boolean) ?? true;
      const includeDl = (params.includeDailyLogs as boolean) ?? true;

      const sections: string[] = [];
      sections.push(`# Hindsight Memory Report`);
      sections.push(`> Project: \`${store.projectKey.slice(0, 16)}…\``);
      sections.push(`> Database: \`${store.dbPath}\``);
      sections.push(`> Vector: ${store.vecAvailable ? "✅ available" : "❌ unavailable"}`);
      sections.push("");

      // — Memories by category
      const count = store.count();
      sections.push(`## Memories (${count.total} total)`);
      sections.push("");

      const categoryOrder = ["decision", "fact", "change", "preference", "error", "task", "constraint"];
      for (const cat of categoryOrder) {
        const catCount = count.byCategory[cat] ?? 0;
        if (catCount === 0) continue;

        // Fetch top items for this category
        const result = store.recall("", {
          category: cat,
          limit,
          mode: "fts",
        });

        sections.push(`### ${cat} (${catCount})`);
        if (result.hits.length === 0) {
          sections.push("*(no recent items)*");
        } else {
          for (const hit of result.hits) {
            const date = new Date(hit.createdAt).toISOString().slice(0, 10);
            sections.push(`- [${date}] (i=${hit.importance.toFixed(2)}, c=${hit.confidence.toFixed(2)}) ${hit.summary}`);
          }
        }
        sections.push("");
      }

      // — Open scratchpad
      if (includeSp) {
        const spItems = store.getOpenScratchpadItems();
        sections.push(`## Scratchpad (${spItems.length} open)`);
        if (spItems.length === 0) {
          sections.push("*(no open items)*");
        } else {
          for (const item of spItems) {
            const pri = item.priority === 2 ? "🔴" : item.priority === 0 ? "🟢" : "🟡";
            sections.push(`- ${pri} [#${item.id}] ${item.label}`);
          }
        }
        sections.push("");
      }

      // — Recent daily logs
      if (includeDl) {
        const logs = store.getRecentDailyLogs(10);
        sections.push(`## Recent Daily Logs (${logs.length})`);
        if (logs.length === 0) {
          sections.push("*(no entries)*");
        } else {
          for (const log of logs) {
            const time = new Date(log.createdAt).toISOString().slice(0, 19).replace("T", " ");
            sections.push(`- [${log.date}] ${time} (${log.entryType}): ${log.content.slice(0, 120)}`);
          }
        }
        sections.push("");
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          totalMemories: count.total,
          byCategory: count.byCategory,
          scratchpadOpen: includeSp ? store.openScratchpadCount() : undefined,
        },
      };
    },
  });
}