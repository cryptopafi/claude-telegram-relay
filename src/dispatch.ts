import { homedir } from "os";
import { join } from "path";
import { appendFile, open, stat } from "fs/promises";
import { createHash } from "crypto";
import { isDuplicate, markProcessed } from "./dispatch-dedup";

export enum TaskType {
  CODE = "code",
  RESEARCH = "research",
  BUSINESS = "business",
  SYSTEM = "system",
  CALENDAR = "calendar",
  EMAIL = "email",
  AUDIT = "audit",
  GENERAL = "general",
}

export type ClassificationResult = {
  type: TaskType;
  confidence: number;
  patterns: string[];
};

export type DispatchResult = {
  handled: boolean;
  skipClaude: boolean;
  response?: string;
  promptHint?: string;
};

type SendMessageFn = (chatId: string, message: string) => Promise<void>;

type DispatchContext = {
  bot: unknown;
  sendMessage: SendMessageFn;
  text: string;
  chatId: string;
  classification: ClassificationResult;
};

type AdapterFn = (context: DispatchContext) => Promise<DispatchResult>;

type PatternRule = {
  name: string;
  regex: RegExp;
  weight: number;
};

type CandidateScore = {
  type: TaskType;
  score: number;
  matchedPatterns: string[];
};

const DISPATCH_CONFIDENCE_THRESHOLD = 0.6;
const CODEX_BRIEF_PATH = join(homedir(), ".codex", "genie-to-codex.md");
const CODEX_DELIVERY_PATH = join(homedir(), ".codex", "codex-to-genie.md");
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const NOT_HANDLED: DispatchResult = {
  handled: false,
  skipClaude: false,
};

const HINTS: Record<TaskType, string> = {
  [TaskType.CODE]:
    "SMART_DISPATCH=code. Treat this as an implementation/debug request. Prefer concrete code-level output, assumptions, and validation steps.",
  [TaskType.RESEARCH]:
    "SMART_DISPATCH=research. Provide structured findings, source-backed claims, confidence levels, and explicit unknowns.",
  [TaskType.BUSINESS]:
    "SMART_DISPATCH=business. Focus on business implications, KPIs, tradeoffs, and recommended decisions.",
  [TaskType.SYSTEM]:
    "SMART_DISPATCH=system. Focus on operations safety: pre-checks, commands, rollback paths, and verification.",
  [TaskType.CALENDAR]:
    "SMART_DISPATCH=calendar. Extract date/time/timezone clearly and return a concise action-ready plan.",
  [TaskType.EMAIL]:
    "SMART_DISPATCH=email. Draft clear subject + body options and keep tone aligned with user's language.",
  [TaskType.AUDIT]:
    "SMART_DISPATCH=audit. Use code-review style: findings first, severity, file references, and concrete fixes.",
  [TaskType.GENERAL]: "",
};

const ROUTING_PATTERNS: Record<Exclude<TaskType, TaskType.GENERAL>, PatternRule[]> = {
  [TaskType.CODE]: [
    { name: "ro-scrie-cod", regex: /\b(scrie\s+cod)\b/i, weight: 1.2 },
    { name: "ro-implementeaza", regex: /\b(implementeaza|implementeaz(?:ă|a))/i, weight: 1.1 },
    { name: "en-write-function", regex: /\b(write\s+(?:a\s+)?function)\b/i, weight: 1.1 },
    { name: "en-fix-bug", regex: /\b(fix(?:ing)?\s+bug)\b/i, weight: 1.2 },
    { name: "en-refactor", regex: /\b(refactor(?:ing|ize)?)\b/i, weight: 1.0 },
    { name: "en-debug", regex: /\b(debug|patch|implement)\b/i, weight: 0.8 },
  ],
  [TaskType.RESEARCH]: [
    { name: "ro-cerceteaza", regex: /\b(cerceteaza|cerceteaz(?:ă|a))/i, weight: 1.2 },
    { name: "en-research", regex: /\b(research)\b/i, weight: 1.1 },
    { name: "en-find-out", regex: /\b(find\s+out)\b/i, weight: 1.0 },
    { name: "ro-cauta-informatii", regex: /\b(caut(?:ă|a)\s+informa(?:ț|t)ii)\b/i, weight: 1.2 },
    { name: "en-investigate", regex: /\b(investigate|look\s+into)\b/i, weight: 0.9 },
  ],
  [TaskType.BUSINESS]: [
    { name: "en-competitor", regex: /\b(competitor|competition)\b/i, weight: 1.1 },
    { name: "ro-pret", regex: /\b(pre(?:ț|t)|pricing)\b/i, weight: 1.0 },
    { name: "en-revenue", regex: /\b(revenue|profit|margin)\b/i, weight: 1.1 },
    { name: "en-market", regex: /\b(market|go[-\s]?to[-\s]?market|gtm)\b/i, weight: 1.0 },
    { name: "ro-client", regex: /\b(client|clien(?:ț|t)i|customer)\b/i, weight: 0.9 },
    { name: "en-sponsor", regex: /\b(sponsor|partnership)\b/i, weight: 0.9 },
  ],
  [TaskType.SYSTEM]: [
    { name: "system-restart", regex: /\b(restart|reporne(?:ș|s)te)\b/i, weight: 1.2 },
    { name: "system-deploy", regex: /\b(deploy|release)\b/i, weight: 1.1 },
    { name: "system-status", regex: /\b(status|uptime|health\s*check)\b/i, weight: 1.1 },
    { name: "system-git-push", regex: /\b(git\s+push|git\s+pull|git\s+rebase)\b/i, weight: 1.1 },
    { name: "system-service", regex: /\b(service|daemon|launchctl|logs?)\b/i, weight: 0.8 },
  ],
  [TaskType.CALENDAR]: [
    { name: "calendar-meeting", regex: /\b(meeting|meet)\b/i, weight: 1.1 },
    { name: "calendar-intalnire", regex: /(întâlnire|intalnire)/i, weight: 1.2 },
    { name: "calendar-word", regex: /\b(calendar|agenda)\b/i, weight: 1.0 },
    { name: "calendar-schedule", regex: /\b(schedule|program(?:eaz(?:ă|a)|are))\b/i, weight: 1.0 },
    { name: "calendar-reminder", regex: /\b(reminder|reaminte(?:ș|s)te)\b/i, weight: 1.0 },
  ],
  [TaskType.EMAIL]: [
    { name: "email-word", regex: /\b(email|e-mail)\b/i, weight: 1.2 },
    { name: "mail-word", regex: /\b(mail)\b/i, weight: 1.0 },
    { name: "inbox-word", regex: /\b(inbox)\b/i, weight: 1.1 },
    { name: "trimite-mail", regex: /\b(trimite\s+mail)\b/i, weight: 1.2 },
    { name: "send-email", regex: /\b(send\s+(?:an\s+)?email)\b/i, weight: 1.1 },
  ],
  [TaskType.AUDIT]: [
    { name: "audit-word", regex: /\b(audit)\b/i, weight: 1.2 },
    { name: "forge-word", regex: /\b(forge)\b/i, weight: 1.1 },
    { name: "review-word", regex: /\b(review|code\s+review)\b/i, weight: 1.1 },
    { name: "verifica-cod", regex: /\b(verific(?:ă|a)\s+codul)\b/i, weight: 1.2 },
    { name: "security-audit", regex: /\b(security\s+check|audit\s+gate)\b/i, weight: 0.9 },
  ],
};

type PollerState = {
  offset: number;
  interval: ReturnType<typeof setInterval>;
  expiresAt: number;
  lastDeliveryFingerprint: string;
  taskId: string;
};

const codexPollers = new Map<string, PollerState>();

function normalizeText(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeConfidence(top: CandidateScore, second: CandidateScore): number {
  if (top.score <= 0) return 0.2;

  const base = 0.38 + top.score * 0.22 + top.matchedPatterns.length * 0.04;
  const ambiguityPenalty = second.score > 0 ? Math.min(0.42, second.score * 0.2) : 0;
  let confidence = base - ambiguityPenalty;

  if (top.score >= 2 && second.score === 0) {
    confidence += 0.04;
  }

  confidence = clamp(confidence, 0.1, 0.95);
  return confidence;
}

export function classifyMessage(text: string): ClassificationResult {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { type: TaskType.GENERAL, confidence: 0.2, patterns: [] };
  }

  const scores: CandidateScore[] = [];
  const taskTypes = Object.keys(ROUTING_PATTERNS) as Array<Exclude<TaskType, TaskType.GENERAL>>;

  for (const taskType of taskTypes) {
    const rules = ROUTING_PATTERNS[taskType];
    const matchedPatterns: string[] = [];
    let score = 0;

    for (const rule of rules) {
      if (rule.regex.test(normalized)) {
        matchedPatterns.push(rule.name);
        score += rule.weight;
      }
    }

    scores.push({
      type: taskType,
      score,
      matchedPatterns,
    });
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1] ?? { type: TaskType.GENERAL, score: 0, matchedPatterns: [] };

  if (!top || top.score <= 0) {
    return { type: TaskType.GENERAL, confidence: 0.2, patterns: [] };
  }

  const confidence = computeConfidence(top, second);
  return {
    type: top.type,
    confidence,
    patterns: top.matchedPatterns,
  };
}

function fallbackPromptHint(type: TaskType): string {
  return HINTS[type] || "";
}

function sanitizeSingleLine(input: string): string {
  return input.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseCodeTaskDescription(input: string): string {
  const stripped = input
    .replace(/^\s*(te\s+rog|please)\s+/i, "")
    .replace(
      /^\s*(scrie\s+cod|implementeaz(?:ă|a|eaza)|write\s+(?:a\s+)?function|write\s+code|fix\s+bug|refactor(?:ize)?)[:\-\s]*/i,
      ""
    )
    .trim();

  return stripped || input.trim();
}

function generateTaskId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `codex-task-${timestamp}-${random}`;
}

function renderCodexBrief(taskId: string, description: string, matchedPatterns: string[]): string {
  const summaryTitle = sanitizeSingleLine(description).slice(0, 90) || "Smart dispatch code task";
  const now = new Date().toISOString();
  const patternsBlock = matchedPatterns.length ? matchedPatterns.join(", ") : "none";

  return `
## Task ${taskId}: SMART-DISPATCH-CODE

**Status**: PENDING
**Prioritate**: HIGH
**Model**: gpt-5.3-codex
**Estimare**: 30 min
**Source**: relay smart dispatch
**Timestamp**: ${now}

### Prompt pentru Codex
**Goal**: ${summaryTitle}

**Context**:
- Routed automatically by Smart Dispatch (pattern matching, no LLM classification)
- Classification patterns: ${patternsBlock}

**Task**:
${description.replace(/^(#{1,6}\s|[*_]{2}Status[*_]{2})/gm, "").trim()}

**Output expected**:
- Implement requested code changes in the relevant repo/workspace
- Validate with available checks/tests
- Append completion note to ~/.codex/codex-to-genie.md
`.trim();
}

async function getFileSize(path: string): Promise<number> {
  try {
    const fileStat = await stat(path);
    return fileStat.size;
  } catch {
    return 0;
  }
}

async function readChunkFromOffset(path: string, offset: number): Promise<{ nextOffset: number; chunk: string }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const fileStat = await handle.stat();

    if (fileStat.size <= offset) {
      return { nextOffset: fileStat.size, chunk: "" };
    }

    const bytesToRead = fileStat.size - offset;
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, offset);
    return {
      nextOffset: fileStat.size,
      chunk: buffer.toString("utf-8"),
    };
  } catch {
    return { nextOffset: offset, chunk: "" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pickDeliveryLine(chunk: string): string {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/\[(m4-\d+|codex-task-[^\]]+|SYNC)/i.test(line)) return line;
    if (/\b(DONE|BLOCKED|ERROR)\b/i.test(line)) return line;
  }

  const header = lines.find((line) => /^##\s+/i.test(line));
  if (header) return header;
  return lines.at(-1) ?? "";
}

function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stopCodexPoller(chatId: string): void {
  const poller = codexPollers.get(chatId);
  if (!poller) return;
  clearInterval(poller.interval);
  codexPollers.delete(chatId);
}

async function startCodexPoller(chatId: string, sendMessage: SendMessageFn, taskId: string): Promise<void> {
  if (!chatId || codexPollers.has(chatId)) return;

  const initialOffset = await getFileSize(CODEX_DELIVERY_PATH);
  const state: PollerState = {
    offset: initialOffset,
    interval: setInterval(() => {}),
    expiresAt: Date.now() + POLL_TIMEOUT_MS,
    lastDeliveryFingerprint: "",
    taskId,
  };

  const tick = async (): Promise<void> => {
    if (Date.now() > state.expiresAt) {
      stopCodexPoller(chatId);
      return;
    }

    const { nextOffset, chunk } = await readChunkFromOffset(CODEX_DELIVERY_PATH, state.offset);
    state.offset = nextOffset;
    if (!chunk.trim()) return;

    const deliveryLine = pickDeliveryLine(chunk);
    if (!deliveryLine) return;

    // Only forward lines that match this task's ID
    if (state.taskId && !deliveryLine.includes(state.taskId)) return;

    const fingerprint = contentFingerprint(deliveryLine);
    if (fingerprint === state.lastDeliveryFingerprint) return;
    state.lastDeliveryFingerprint = fingerprint;

    const safeLine = deliveryLine.slice(0, 360);
    await sendMessage(chatId, `Codex update: ${safeLine}`).catch(() => {});
  };

  state.interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  if (typeof (state.interval as any).unref === "function") {
    (state.interval as any).unref();
  }

  codexPollers.set(chatId, state);
}

export async function codexAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.CODE) return NOT_HANDLED;

  const description = parseCodeTaskDescription(context.text);
  const taskId = generateTaskId();
  const brief = renderCodexBrief(taskId, description, context.classification.patterns);

  try {
    await appendFile(CODEX_BRIEF_PATH, `\n\n${brief}\n`, "utf-8");
    await startCodexPoller(context.chatId, context.sendMessage, taskId);
    return {
      handled: true,
      skipClaude: true,
      response: `Task dispatched to Codex (${taskId}). I will post delivery updates here.`,
    };
  } catch (error) {
    console.warn("[SMART_DISPATCH] codexAdapter failed:", error);
    return {
      handled: true,
      skipClaude: false,
      promptHint: fallbackPromptHint(TaskType.CODE),
    };
  }
}

export async function sentinelAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.SYSTEM) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.SYSTEM),
  };
}

export async function researchAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.RESEARCH) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.RESEARCH),
  };
}

export async function forgeAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.AUDIT) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.AUDIT),
  };
}

export async function calendarAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.CALENDAR) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.CALENDAR),
  };
}

export async function emailAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.EMAIL) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.EMAIL),
  };
}

export async function radarAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.BUSINESS) return NOT_HANDLED;
  return {
    handled: true,
    skipClaude: false,
    promptHint: fallbackPromptHint(TaskType.BUSINESS),
  };
}

const ADAPTER_BY_TYPE: Record<Exclude<TaskType, TaskType.GENERAL>, AdapterFn> = {
  [TaskType.CODE]: codexAdapter,
  [TaskType.RESEARCH]: researchAdapter,
  [TaskType.BUSINESS]: radarAdapter,
  [TaskType.SYSTEM]: sentinelAdapter,
  [TaskType.CALENDAR]: calendarAdapter,
  [TaskType.EMAIL]: emailAdapter,
  [TaskType.AUDIT]: forgeAdapter,
};

export function initDispatch(bot: unknown, sendMessage: SendMessageFn) {
  return {
    async handle(text: string, chatId: string): Promise<DispatchResult> {
      const classification = classifyMessage(text);

      if (
        classification.type === TaskType.GENERAL ||
        classification.confidence < DISPATCH_CONFIDENCE_THRESHOLD
      ) {
        return NOT_HANDLED;
      }

      if (isDuplicate(text)) {
        return {
          handled: true,
          skipClaude: true,
          response: "Duplicate task detected. Skipping re-dispatch.",
        };
      }

      const adapter = ADAPTER_BY_TYPE[classification.type];
      if (!adapter) return NOT_HANDLED;

      const result = await adapter({
        bot,
        sendMessage,
        text,
        chatId,
        classification,
      });

      if (result.handled && result.skipClaude) {
        markProcessed(text);
      }

      return result;
    },
  };
}
