/**
 * capture.ts — tier-1 heuristic memory capture from assistant messages.
 *
 * Runs inside message_end handler, zero LLM cost.
 * Extracts decision/fact/change/preference signals via pattern matching.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryStore, DraftMemory } from "./memory-store.js";

// ————————————————————————————————————————
// Heuristic patterns
// ————————————————————————————————————————

/** Decision-indicating patterns — agent chose a direction */
const DECISION_PATTERNS = [
  /\b(?:decided?|chose?|select(?:ed|ing)?|opted?\s+for|settled?\s+on)\b/i,
  /\b(?:going\s+with|will\s+use|plan\s+to\s+(?:use|implement)|approach\s+is)\b/i,
  /\b(?:recommend(?:ed|ation)?|prefer(?:red)?|better\s+to\s+use)\b/i,
];

/** Change-indicating patterns — code was modified */
const CHANGE_PATTERNS = [
  /\b(?:added?|removed?|updated?|changed?|renamed?|moved?|refactored?|fixed?)\b/i,
  /\b(?:implement(?:ed|ing)?|extract(?:ed|ing)?|introduce(?:d)?)\b/i,
  /\b(?:replac(?:ed?|ing)|migrate(?:d)?|convert(?:ed)?|rewrote?)\b/i,
];

/** Fact-indicating patterns — timeless truth about the project */
const FACT_PATTERNS = [
  /\b(?:is\s+(?:a|an|the|built|written|based)|runs?\s+on|uses?\s+|depends?\s+on)\b/i,
  /\b(?:architecture|stack|framework|librar(?:y|ies)|tool|language|version)\b/i,
  /\b(?:configur(?:ed?|ation)|environment|deploy(?:ed?|ment)?)\b/i,
];

/** Preference-indicating patterns — user's personal choice */
const PREFERENCE_PATTERNS = [
  /\b(?:prefer|like|dislike|want|don't\s+want|avoid)\b/i,
  /\b(?:convention|style|naming|format|standard)\b/i,
  /\b(?:opinion|personally|i\s+think|i\s+feel)\b/i,
];

// ————————————————————————————————————————
// Sentence extraction
// ————————————————————————————————————————

function* extractSentences(text: string): Generator<string> {
  // Split on sentence boundaries, keeping meaningful sentences
  const raw = text.split(/(?<=[.!?])\s+/);
  for (const s of raw) {
    const trimmed = s.trim();
    // Skip short, code-only, or purely technical lines
    if (trimmed.length < 20) continue;
    if (/^```/.test(trimmed)) continue;
    if (/^[{\[`\s]/.test(trimmed) && !/[a-zA-Z]{3,}/.test(trimmed)) continue;
    yield trimmed;
  }
}

function classifySentence(sentence: string): { category: "decision" | "fact" | "change" | "preference" | null; score: number } {
  let best: { category: "decision" | "fact" | "change" | "preference" | null; score: number } = { category: null, score: 0 };

  const checks: Array<{ patterns: RegExp[]; category: "decision" | "fact" | "change" | "preference" }> = [
    { patterns: DECISION_PATTERNS, category: "decision" },
    { patterns: CHANGE_PATTERNS, category: "change" },
    { patterns: FACT_PATTERNS, category: "fact" },
    { patterns: PREFERENCE_PATTERNS, category: "preference" },
  ];

  for (const check of checks) {
    let matchCount = 0;
    for (const p of check.patterns) {
      if (p.test(sentence)) matchCount++;
    }
    if (matchCount > 0) {
      const score = matchCount / check.patterns.length;
      if (score > best.score) {
        best = { category: check.category, score };
      }
    }
  }

  return best;
}

// ————————————————————————————————————————
// Tier-1 capture handler
// ————————————————————————————————————————

export function registerCapture(pi: ExtensionAPI, store: MemoryStore, options?: { minSentenceLen?: number }): void {
  const minLen = options?.minSentenceLen ?? 20;

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    // Flatten text content from the assistant message
    const texts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === "text") {
        texts.push(block.text);
      }
    }
    const fullText = texts.join("\n");
    if (fullText.length < minLen) return;

    // Extract session identity
    // (sessionManager is available via ctx in message_end)
    // We'll handle ctx access below

    // Extract candidate sentences
    const drafts: DraftMemory[] = [];
    const seen = new Set<string>();

    for (const sentence of extractSentences(fullText)) {
      const classification = classifySentence(sentence);
      if (!classification.category || classification.score < 0.2) continue;

      // Summarize to first 200 chars as "summary"
      const summary = sentence.length > 200 ? sentence.slice(0, 200) + "…" : sentence;

      // Dedup by normalized prefix
      const key = summary.slice(0, 80).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      drafts.push({
        summary,
        detail: sentence,
        category: classification.category,
        importance: 0.2 + classification.score * 0.3, // 0.2–0.5 range for tier-1
        sessionId: undefined, // set below if ctx available
        turnIndex: undefined,
      });
    }

    if (drafts.length === 0) return;

    // Store in a batch transaction
    const count = store.storeBatch(drafts);
    if (count > 0) {
      console.debug(`[pi-hindsight] tier-1 captured ${count} memories`);
    }
  });
}
