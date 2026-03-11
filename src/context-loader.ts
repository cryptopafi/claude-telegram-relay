import { readFile } from "fs/promises";
import { readdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type Intent =
  | "simple_chat"
  | "code_task"
  | "research_query"
  | "business_question"
  | "system_op"
  | "calendar_event"
  | "email_task"
  | "audit_request";

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface ContextResult {
  systemPrompt: string;
  contextBlocks: string[];
  totalChars: number;
  tier: number;
}

export interface ContextLoaderDeps {
  systemPromptTemplate?: string;
  rulesCache?: CortexRulesCache;
  loadCortexRules?: () => Promise<string>;
  loadMemorySummary?: (text: string) => Promise<string> | string;
  loadCortexContext?: (text: string) => Promise<string>;
  loadCortexProcedures?: (text: string) => Promise<string>;
  loadSharedMemory?: () => Promise<string>;
  loadSessionLive?: () => Promise<string>;
  loadSentinelHealth?: () => Promise<string>;
  formatHistory?: (history: Message[]) => string;
}

const INTENT_RULES: Array<{ intent: Intent; patterns: RegExp[] }> = [
  {
    intent: "audit_request",
    patterns: [
      /\b(audit|review(?:\s+code)?|forge|security\s+check|verific(?:a|ă)\s+codul?)\b/i,
      /\b(code\s+review|quality\s+gate|nplf)\b/i,
    ],
  },
  {
    intent: "calendar_event",
    patterns: [
      /\b(calendar|meeting|schedule|reminder|event)\b/i,
      /\b(întâlnire|intalnire|program(?:eaz|a)|calendarul?)\b/i,
    ],
  },
  {
    intent: "email_task",
    patterns: [
      /\b(email|mail|inbox|gmail|follow[-\s]?up)\b/i,
      /\b(trimite\s+mail|verific(?:a|ă)\s+inbox|mesaj\s+email)\b/i,
    ],
  },
  {
    intent: "system_op",
    patterns: [
      /\b(restart|deploy|status|health\s*check|launchctl|daemon|service|logs?)\b/i,
      /\b(git\s+(?:push|pull|fetch|rebase)|ssh|scp|pkill|process)\b/i,
    ],
  },
  {
    intent: "business_question",
    patterns: [
      /\b(business|market\w*|competitor\w*|pricing|price\w*|revenue\w*|profit\w*|client\w*|sales)\b/i,
      /\b(afacere\w*|pia(?:ț|t)\w*|competitor\w*|pre(?:ț|t)\w*|venit\w*|client\w*|sponsor\w*)\b/i,
    ],
  },
  {
    intent: "research_query",
    patterns: [
      /\b(research|investigate|analy[sz]e|compare|benchmark|find\s+out)\b/i,
      /\b(cerceteaz(?:ă|a)|analizeaz(?:ă|a)|stud(?:iu|iază)|informa(?:ț|t)ii)\b/i,
    ],
  },
  {
    intent: "code_task",
    patterns: [
      /\b(code|coding|bug|fix|implement|refactor|script|function|test|typescript|python)\b/i,
      /\b(cod|bug|fix|implementeaz(?:ă|a)|refactor|script|test)\b/i,
    ],
  },
];

const TIER2_INTENTS = new Set<Intent>(["research_query", "audit_request", "business_question"]);
const CORTEX_URL = process.env.CORTEX_URL || "http://localhost:6400";
const MEMORY_DIR = join(process.env.HOME || homedir(), ".claude/projects/-Users-pafi/memory");
const SESSION_LIVE_PATH = join(process.env.HOME || homedir(), ".nexus/workspace/intel/SESSION-LIVE.md");
const SENTINEL_HEALTH_PATH = join(process.env.HOME || homedir(), ".nexus/workspace/intel/SENTINEL-HEALTH.md");
const SYSTEM_PROMPT_PATH = join(dirname(import.meta.path), "prompts", "system.xml");
const MAX_HISTORY_CHARS = 8000;

const LIMITS = {
  rules: 5000,
  memorySummary: 2200,
  sessionLive: 2500,
  cortexContext: 6000,
  procedures: 4500,
  sentinel: 1800,
  sharedMemory: 5000,
};

export function classifyMessageIntent(text: string): Intent {
  const source = (text || "").trim();
  if (!source) return "simple_chat";

  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((re) => re.test(source))) {
      return rule.intent;
    }
  }
  return "simple_chat";
}

export class CortexRulesCache {
  private cachedValue = "";
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly fetcher: () => Promise<string>,
    private readonly ttlMs: number = 5 * 60 * 1000
  ) {}

  async getRules(): Promise<string> {
    const now = Date.now();
    if (this.cachedValue && now < this.expiresAt) {
      return this.cachedValue;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetcher()
      .then((rules) => {
        const normalized = String(rules || "");
        this.cachedValue = normalized;
        this.expiresAt = Date.now() + this.ttlMs;
        return normalized;
      })
      .catch((error) => {
        console.warn("[CONTEXT] Cortex rules cache fetch failed:", error);
        return this.cachedValue;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  clear(): void {
    this.cachedValue = "";
    this.expiresAt = 0;
    this.inFlight = null;
  }
}

function safeSlice(text: string, limit: number): string {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function pushUniqueBlock(target: string[], seen: Set<string>, title: string, body: string): void {
  const trimmed = String(body || "").trim();
  if (!trimmed) return;
  const normalized = trimmed.toLowerCase();
  if (seen.has(normalized)) return;
  seen.add(normalized);
  target.push(`${title}\n${trimmed}`);
}

function defaultHistoryFormatter(history: Message[]): string {
  if (!history || history.length === 0) return "";
  let totalChars = 0;
  const recent = [...history].reverse();
  const included: string[] = [];

  for (const msg of recent) {
    const line = `${msg.role === "user" ? "Pafi" : "Assistant"}: ${msg.content || ""}`;
    if (totalChars + line.length > MAX_HISTORY_CHARS) break;
    included.unshift(line);
    totalChars += line.length;
  }

  if (included.length === 0) return "";
  return included.join("\n");
}

async function defaultLoadSystemPrompt(): Promise<string> {
  try {
    return await readFile(SYSTEM_PROMPT_PATH, "utf-8");
  } catch {
    return "";
  }
}

async function defaultLoadSessionLive(): Promise<string> {
  try {
    return await readFile(SESSION_LIVE_PATH, "utf-8");
  } catch {
    return "";
  }
}

async function defaultLoadSentinelHealth(): Promise<string> {
  try {
    return await readFile(SENTINEL_HEALTH_PATH, "utf-8");
  } catch {
    return "";
  }
}

async function defaultLoadSharedMemory(): Promise<string> {
  const parts: string[] = [];
  try {
    const memory = await readFile(join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    parts.push("SHARED MEMORY (from Claude Code sessions):\n" + memory);
  } catch {}

  try {
    const files = readdirSync(MEMORY_DIR)
      .filter((f) => f.startsWith("session-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const latest = await readFile(join(MEMORY_DIR, files[0]), "utf-8");
      parts.push("LATEST SESSION:\n" + latest.substring(0, 2200));
    }
  } catch {}

  return parts.join("\n\n");
}

async function fetchCortexRulesDirect(): Promise<string> {
  try {
    const response = await fetch(`${CORTEX_URL}/api/rules`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return "";
    const data = await response.json();
    if (!Array.isArray(data.rules) || data.rules.length === 0) return "";
    return (
      "HARD RULES (must follow):\n" +
      data.rules.map((rule: any) => `- [${rule.category || "GENERAL"}] ${rule.text}`).join("\n")
    );
  } catch {
    return "";
  }
}

function intentHint(intent: Intent): string {
  switch (intent) {
    case "code_task":
      return "Intent: coding request. Prefer concrete implementation steps and validations.";
    case "research_query":
      return "Intent: research query. Prioritize sourced facts, comparisons, and uncertainty labels.";
    case "business_question":
      return "Intent: business question. Focus on trade-offs, risks, and practical recommendations.";
    case "system_op":
      return "Intent: system operation. Be operationally precise, include status/risk checks.";
    case "calendar_event":
      return "Intent: calendar event. Focus on schedule details, constraints, and confirmations.";
    case "email_task":
      return "Intent: email task. Produce concise drafts or triage actions with recipient intent.";
    case "audit_request":
      return "Intent: audit request. Prioritize correctness, findings, severity, and test evidence.";
    default:
      return "Intent: simple chat. Keep response short and direct unless depth is requested.";
  }
}

async function maybeLoad(loader?: () => Promise<string> | string): Promise<string> {
  if (!loader) return "";
  try {
    return String(await loader());
  } catch {
    return "";
  }
}

export async function loadContextForMessage(
  text: string,
  intent: Intent,
  history: Message[],
  deps: ContextLoaderDeps = {}
): Promise<ContextResult> {
  const contextBlocks: string[] = [];
  const seen = new Set<string>();

  const [systemPrompt, historyBlock, rulesBlock] = await Promise.all([
    deps.systemPromptTemplate ? Promise.resolve(deps.systemPromptTemplate) : defaultLoadSystemPrompt(),
    Promise.resolve((deps.formatHistory || defaultHistoryFormatter)(history || [])),
    deps.rulesCache
      ? deps.rulesCache.getRules()
      : maybeLoad(deps.loadCortexRules || fetchCortexRulesDirect),
  ]);

  pushUniqueBlock(contextBlocks, seen, "[Tier 0] Conversation History:", historyBlock);
  pushUniqueBlock(contextBlocks, seen, "[Tier 0] Cortex Rules:", safeSlice(rulesBlock, LIMITS.rules));

  const [memorySummary, sessionLive] = await Promise.all([
    maybeLoad(() => deps.loadMemorySummary?.(text)),
    maybeLoad(deps.loadSessionLive || defaultLoadSessionLive),
  ]);

  pushUniqueBlock(contextBlocks, seen, "[Tier 1] Memory Summary (FTS5):", safeSlice(memorySummary, LIMITS.memorySummary));
  pushUniqueBlock(contextBlocks, seen, "[Tier 1] SESSION-LIVE:", safeSlice(sessionLive, LIMITS.sessionLive));
  pushUniqueBlock(contextBlocks, seen, "[Tier 1] Intent Hint:", intentHint(intent));

  let tier = 1;

  if (TIER2_INTENTS.has(intent)) {
    const [cortexContext, procedures, sentinelHealth, sharedMemory] = await Promise.all([
      maybeLoad(() => deps.loadCortexContext?.(text)),
      maybeLoad(() => deps.loadCortexProcedures?.(text)),
      maybeLoad(deps.loadSentinelHealth || defaultLoadSentinelHealth),
      maybeLoad(deps.loadSharedMemory || defaultLoadSharedMemory),
    ]);

    pushUniqueBlock(contextBlocks, seen, "[Tier 2] Cortex Deep Context:", safeSlice(cortexContext, LIMITS.cortexContext));
    pushUniqueBlock(contextBlocks, seen, "[Tier 2] Cortex Procedures:", safeSlice(procedures, LIMITS.procedures));
    pushUniqueBlock(contextBlocks, seen, "[Tier 2] SENTINEL Health:", safeSlice(sentinelHealth, LIMITS.sentinel));
    pushUniqueBlock(contextBlocks, seen, "[Tier 2] Full Memory Sections:", safeSlice(sharedMemory, LIMITS.sharedMemory));
    tier = 2;
  }

  const promptText = String(systemPrompt || "");
  const totalChars = promptText.length + contextBlocks.reduce((acc, item) => acc + item.length, 0);

  return {
    systemPrompt: promptText,
    contextBlocks,
    totalChars,
    tier,
  };
}
