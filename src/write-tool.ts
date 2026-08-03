/**
 * write-tool.ts — memory_write / memory_forget tools for pi.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore, DraftMemory } from "./memory-store.js";

const VALID_CATEGORIES = ["decision", "fact", "preference", "change", "error", "task", "constraint"] as const;

const WriteParams = Type.Object({
  summary: Type.String({ description: "记忆摘要（必填，简短描述）" }),
  detail: Type.Optional(Type.String({ description: "详细内容（可选）" })),
  category: Type.Optional(Type.String({
    description: "类别: decision|fact|preference|change|error|task|constraint（默认 fact）",
  })),
  importance: Type.Optional(Type.Number({ description: "重要性 0–1（默认 0.3）" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "标签数组（可选）" })),
});

const ForgetParams = Type.Object({
  id: Type.Optional(Type.Number({ description: "要删除的记忆 ID（精确匹配）" })),
  query: Type.Optional(Type.String({ description: "关键词搜索匹配后删除 top-N（与 id 二选一）" })),
  limit: Type.Optional(Type.Number({ description: "query 模式最多删除条数（默认 5，最大 50）" })),
});

export function registerWriteTool(pi: ExtensionAPI, store: MemoryStore): void {
  // ——————————————————————
  // memory_write
  // ——————————————————————
  pi.registerTool({
    name: "memory_write",
    label: "Write Memory",
    description:
      "Explicitly write a memory into Hindsight. " +
      "Useful for recording decisions, facts, or lessons that the auto-capture missed. " +
      "Example: `memory_write({summary: 'auth uses JWT HS256', category: 'decision', importance: 0.8})`.",
    parameters: WriteParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const summary = (params.summary as string).trim();
      if (!summary) {
        return {
          content: [{ type: "text" as const, text: "Error: `summary` is required and cannot be empty." }],
          details: {},
          isError: true,
        };
      }

      const rawCategory = (params.category as string | undefined) ?? "fact";
      const category = rawCategory.toLowerCase();
      if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid category: "${rawCategory}". Allowed: ${VALID_CATEGORIES.join(", ")}`,
          }],
          details: {},
          isError: true,
        };
      }

      let importance = params.importance as number | undefined;
      if (importance !== undefined) {
        importance = Math.max(0, Math.min(1, importance));
      }

      const rawTags = params.tags as string[] | undefined;
      const tags = rawTags && rawTags.length > 0 ? rawTags.join(", ") : undefined;

      const draft: DraftMemory = {
        summary,
        detail: params.detail as string | undefined,
        category: category as DraftMemory["category"],
        importance,
        tags,
      };

      const vec = await store.embedDraft(draft);
      const row = store.store(draft, { vector: vec });

      return {
        content: [{
          type: "text" as const,
          text: `✅ Memory written (id: ${row.id}, category: ${row.category})`,
        }],
        details: {
          ok: true,
          id: row.id,
          category: row.category,
          projectKey: store.projectKey,
          message: "Memory written successfully",
        },
      };
    },
  });

  // ——————————————————————
  // memory_forget
  // ——————————————————————
  pi.registerTool({
    name: "memory_forget",
    label: "Forget Memory",
    description:
      "Archive (soft-delete) one or more memories by ID or by keyword query. " +
      "Archived memories are excluded from recall but remain in the database. " +
      "Example: `memory_forget({id: 42})` or `memory_forget({query: 'outdated config', limit: 3})`.",
    parameters: ForgetParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const id = params.id as number | undefined;
      const query = params.query as string | undefined;
      const limit = Math.min((params.limit as number) ?? 5, 50);

      if (!id && !query) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: provide either `id` (exact) or `query` (keyword search) to forget.",
          }],
          details: {},
          isError: true,
        };
      }

      const archivedIds: number[] = [];

      if (id !== undefined) {
        const ok = store.archiveMemory(id);
        if (ok) {
          archivedIds.push(id);
        }
        return {
          content: [{
            type: "text" as const,
            text: ok
              ? `✅ Memory #${id} archived.`
              : `Memory #${id} not found or already archived.`,
          }],
          details: {
            ok,
            archived: ok ? [id] : [],
            count: ok ? 1 : 0,
          },
        };
      }

      // Query mode: search by FTS, archive top-N
      const result = await store.recall(query!, {
        mode: "fts",
        limit,
      });

      for (const hit of result.hits) {
        const ok = store.archiveMemory(hit.id);
        if (ok) {
          archivedIds.push(hit.id);
        }
      }

      if (archivedIds.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No matching memories found to archive.",
          }],
          details: {
            ok: false,
            archived: [],
            count: 0,
            totalMatching: result.total,
          },
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `✅ Archived ${archivedIds.length} memories (query: "${query}"). IDs: ${archivedIds.join(", ")}`,
        }],
        details: {
          ok: true,
          archived: archivedIds,
          count: archivedIds.length,
          totalMatching: result.total,
        },
      };
    },
  });

  // ——————————————————————
  // memory_restore
  // ——————————————————————
  pi.registerTool({
    name: "memory_restore",
    label: "Restore Memory",
    description:
      "Restore archived (soft-deleted) memories by ID or by keyword query. " +
      "Reverse of memory_forget. " +
      "Example: `memory_restore({id: 42})` or `memory_restore({query: \"important config\", limit: 3})`.",
    parameters: Type.Object({
      id: Type.Optional(Type.Number({ description: "要恢复的记忆 ID（精确匹配）" })),
      query: Type.Optional(Type.String({ description: "关键词搜索匹配后恢复 top-N（与 id 二选一）" })),
      limit: Type.Optional(Type.Number({ description: "query 模式最多恢复条数（默认 5，最大 50）" })),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const id = params.id as number | undefined;
      const query = params.query as string | undefined;
      const limit = Math.min((params.limit as number) ?? 5, 50);

      if (!id && !query) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either `id` (exact) or `query` (keyword search) to restore." }],
          details: {},
          isError: true,
        };
      }

      const restoredIds: number[] = [];

      if (id !== undefined) {
        const ok = store.restoreMemory(id);
        if (ok) restoredIds.push(id);
        return {
          content: [{ type: "text" as const, text: ok ? `✅ Memory #${id} restored.` : `Memory #${id} not found or not archived.` }],
          details: { ok, restored: ok ? [id] : [], count: ok ? 1 : 0 },
        };
      }

      // Query mode: search archived by FTS, restore top-N
      const result = store.recallArchived(query!, { limit });

      for (const hit of result.hits) {
        const ok = store.restoreMemory(hit.id);
        if (ok) restoredIds.push(hit.id);
      }

      if (restoredIds.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching archived memories found to restore." }],
          details: { ok: false, restored: [], count: 0, totalMatching: result.total },
        };
      }

      return {
        content: [{ type: "text" as const, text: `✅ Restored ${restoredIds.length} memories (query: "${query}"). IDs: ${restoredIds.join(", ")}` }],
        details: { ok: true, restored: restoredIds, count: restoredIds.length, totalMatching: result.total },
      };
    },
  });
}