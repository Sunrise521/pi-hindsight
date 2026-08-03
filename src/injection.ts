/**
 * injection.ts — Context injection for pi-hindsight.
 *
 * When PI_MEM_AMBIENT=1, injects into the system prompt before each agent turn:
 * 1. Today's daily_log tail (≤ 2K char)
 * 2. Top-5 high-importance memories (importance ≥ 0.7, ≤ 2K char)
 * 3. Open scratchpad items (≤ 1K char)
 *
 * Total cap: 5K char (PI_MEM_AMBIENT_MAX_CHARS)
 *
 * KV-cache stable snapshot strategy:
 * - Refresh on session_start, session_before_compact, or dirty mark
 * - Otherwise byte-level stable
 */
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./memory-store.js";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getEnv(key: string, defaultVal: string): string {
  return (process.env as Record<string, string | undefined>)[key] ?? defaultVal;
}

function trimTo(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "\n…[truncated]";
}

export function registerInjection(pi: ExtensionAPI, store: MemoryStore): void {
  const ambient = getEnv("PI_MEM_AMBIENT", "0");
  if (ambient !== "1") {
    console.debug("[pi-hindsight] ambient mode disabled (PI_MEM_AMBIENT=0)");
    return;
  }

  const maxChars = parseInt(getEnv("PI_MEM_AMBIENT_MAX_CHARS", "5000"), 10);
  const maxFacts = parseInt(getEnv("PI_MEM_AMBIENT_MAX_FACTS", "5"), 10);

  let snapshot: string | null = null;
  let dirty = true;

  // Mark dirty on session_before_compact (handoff may have written new data)
  pi.on("session_before_compact", async () => {
    dirty = true;
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx): Promise<BeforeAgentStartEventResult | void> => {
    if (!dirty && snapshot !== null) {
      // Stable snapshot — inject cached version
      return { systemPrompt: event.systemPrompt + "\n\n" + snapshot };
    }

    // Rebuild snapshot
    const parts: string[] = [];

    // 1. Today's daily_log tail (≤ 2K char)
    const todayLogs = store.getDailyLogsByDate(today(), 20);
    if (todayLogs.length > 0) {
      const logLines = todayLogs.reverse().map(e => e.content).join("\n");
      parts.push(`<hindsight_daily_log date="${today()}">\n${trimTo(logLines, 2000)}\n</hindsight_daily_log>`);
    }

    // 2. High-importance memories (≤ 2K char)
    const topMemories = store.recall("", {
      limit: maxFacts,
      mode: "fts",
    });
    // Filter by importance ≥ 0.7
    const highImp = topMemories.hits.filter(h => h.importance >= 0.7);
    if (highImp.length > 0) {
      const factLines = highImp.map((h, i) =>
        `${i + 1}. [${h.category}] ${h.summary}`,
      );
      parts.push(`<hindsight_key_facts>\n${trimTo(factLines.join("\n"), 2000)}\n</hindsight_key_facts>`);
    }

    // 3. Open scratchpad items (≤ 1K char)
    const openSp = store.getOpenScratchpadItems(20);
    if (openSp.length > 0) {
      const spLines = openSp.map((item, i) => {
        const pri = item.priority === 2 ? "high" : item.priority === 0 ? "low" : "normal";
        return `${i + 1}. [${pri}] ${item.label}`;
      });
      parts.push(`<hindsight_scratchpad>\n${trimTo(spLines.join("\n"), 1000)}\n</hindsight_scratchpad>`);
    }

    const combined = parts.join("\n\n");
    snapshot = trimTo(combined, maxChars);
    dirty = false;

    return { systemPrompt: event.systemPrompt + "\n\n" + snapshot };
  });

  console.debug(`[pi-hindsight] ambient mode enabled (maxChars=${maxChars}, maxFacts=${maxFacts})`);
}