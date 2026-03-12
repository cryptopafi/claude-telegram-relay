import { homedir } from "os";
import { join } from "path";
import { appendFile, mkdir, open, readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { isDuplicate, markProcessed } from "./dispatch-dedup";
import { isEnabled } from "./feature-flags";

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

type AdapterMap = Partial<Record<Exclude<TaskType, TaskType.GENERAL>, AdapterFn>>;

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

type RoutingDomain = "research" | "marketing" | "development" | "ops" | "orchestration";
type NexusComplexity = "low" | "medium" | "high";
type NexusTaskType = Exclude<TaskType, TaskType.CODE | TaskType.GENERAL>;

type NexusRouteConfig = {
  agent: string;
  domain: RoutingDomain;
  complexity: NexusComplexity;
  budgetUsd: string;
};

const DISPATCH_CONFIDENCE_THRESHOLD = 0.6;
const CODEX_BRIEF_PATH = join(homedir(), ".codex", "genie-to-codex.md");
const CODEX_DELIVERY_PATH = join(homedir(), ".codex", "codex-to-genie.md");
const NEXUS_SCRIPTS_DIR = join(homedir(), ".nexus", "scripts");
const NEXUS_WORKSPACE_DIR = join(homedir(), ".nexus", "workspace");
const NEXUS_TASK_CREATE_PATH = join(NEXUS_SCRIPTS_DIR, "nexus-task-create.sh");
const NEXUS_ROUTING_TABLE_PATH = join(homedir(), ".nexus", "config", "routing-table.yaml");
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const NEXUS_POLL_INTERVAL_MS = 5000;
const NEXUS_CREATE_TIMEOUT_MS = 10_000;
const MAX_READ_CHUNK_BYTES = 64 * 1024;

const ROUTING_TIMEOUT_DEFAULTS: Record<RoutingDomain, number> = {
  research: 2700,
  marketing: 1800,
  development: 2700,
  ops: 600,
  orchestration: 1800,
};

const NEXUS_ROUTE_BY_TASK: Record<NexusTaskType, NexusRouteConfig> = {
  [TaskType.RESEARCH]: { agent: "iris", domain: "research", complexity: "medium", budgetUsd: "2.00" },
  [TaskType.SYSTEM]: { agent: "sentinel", domain: "ops", complexity: "low", budgetUsd: "0.50" },
  [TaskType.AUDIT]: { agent: "forge", domain: "development", complexity: "medium", budgetUsd: "2.00" },
  [TaskType.BUSINESS]: { agent: "mercury", domain: "marketing", complexity: "medium", budgetUsd: "2.00" },
  [TaskType.CALENDAR]: { agent: "genie", domain: "orchestration", complexity: "low", budgetUsd: "0.50" },
  [TaskType.EMAIL]: { agent: "genie", domain: "orchestration", complexity: "low", budgetUsd: "0.50" },
};

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
  inode: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  expiresAt: number;
  seenFingerprints: Set<string>;
  taskId: string;
  isTickRunning: boolean;
  leftoverLine: string;
  idleTicks: number;
};

const codexPollers = new Map<string, PollerState>();

type NexusPollerState = {
  timer: ReturnType<typeof setTimeout> | null;
  expiresAt: number;
  lastStatus: string;
  chatId: string;
  sendMessage: SendMessageFn;
  route: NexusRouteConfig;
  isTickRunning: boolean;
};

const nexusPollers = new Map<string, NexusPollerState>();
let routingTimeoutCache: Record<RoutingDomain, number> | null = null;

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

function generateNexusTaskId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `task-${timestamp}-${random}`;
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

async function readChunkFromOffset(
  path: string,
  offset: number,
  lastInode: number | null
): Promise<{ nextOffset: number; chunk: string; inode: number | null }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const fileStat = await handle.stat();

    // H1 fix: detect log rotation (inode change or shrink) and reset offset to 0
    if ((lastInode != null && fileStat.ino !== lastInode) || fileStat.size < offset) {
      offset = 0;
    }
    if (fileStat.size === offset) {
      return { nextOffset: offset, chunk: "", inode: fileStat.ino ?? null };
    }

    const bytesToRead = Math.min(fileStat.size - offset, MAX_READ_CHUNK_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);

    // UTF-8 safe boundary: avoid splitting multi-byte characters at chunk edge.
    // Always validate — even at EOF, a mid-flush write can leave incomplete chars.
    let safeBytesRead = bytesRead;
    const getUtf8SeqLen = (lead: number): number => {
      if ((lead & 0x80) === 0x00) return 1;
      if ((lead & 0xe0) === 0xc0) return 2;
      if ((lead & 0xf0) === 0xe0) return 3;
      if ((lead & 0xf8) === 0xf0) return 4;
      return 1;
    };
    let trailing = 0;
    while (trailing < bytesRead && (buffer[bytesRead - 1 - trailing] & 0xc0) === 0x80) {
      trailing++;
    }
    if (trailing > 0) {
      const leadIndex = bytesRead - 1 - trailing;
      if (leadIndex >= 0) {
        const expectedLen = getUtf8SeqLen(buffer[leadIndex]);
        const availableLen = trailing + 1;
        if (expectedLen > availableLen) {
          safeBytesRead = leadIndex;
        }
      }
    } else if (bytesRead > 0) {
      const last = buffer[bytesRead - 1];
      const expectedLen = getUtf8SeqLen(last);
      if (expectedLen > 1) {
        safeBytesRead = bytesRead - 1;
      }
    }
    // Guard: if all bytes were continuation bytes (corrupt data), advance anyway
    if (safeBytesRead === 0 && bytesRead > 0) {
      safeBytesRead = bytesRead;
    }

    return {
      nextOffset: offset + safeBytesRead,
      chunk: buffer.subarray(0, safeBytesRead).toString("utf-8"),
      inode: fileStat.ino ?? null,
    };
  } catch {
    return { nextOffset: offset, chunk: "", inode: lastInode ?? null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pickDeliveryLines(chunk: string): string[] {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // H3 fix: collect ALL matching lines across all categories instead of
  // early-returning on the first match type (which dropped valid status lines)
  const seen = new Set<string>();
  const result: string[] = [];

  const addUnique = (line: string): void => {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  };

  for (const line of lines) {
    if (/\[(m4-\d+|codex-task-[^\]]+|SYNC)/i.test(line)) addUnique(line);
    else if (/^##\s+/i.test(line)) addUnique(line);
    else if (/\b(DONE|BLOCKED|ERROR)\b/i.test(line)) addUnique(line);
  }

  // Fallback: last line if nothing matched
  if (result.length === 0) {
    const last = lines[lines.length - 1];
    if (last) result.push(last);
  }

  return result;
}

function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stopCodexPoller(taskId: string): void {
  const poller = codexPollers.get(taskId);
  if (!poller) return;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  codexPollers.delete(taskId);
}

function stopNexusPoller(taskId: string): void {
  const poller = nexusPollers.get(taskId);
  if (!poller) return;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  nexusPollers.delete(taskId);
}

function parseProgressScalar(content: string, key: string): string {
  const match = content.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"));
  const raw = match?.[1]?.trim() ?? "";
  if (!raw || /^null$/i.test(raw)) return "";
  const quoted = raw.match(/^["'](.*)["']$/);
  return quoted ? quoted[1] : raw;
}

async function readNexusProgress(taskId: string): Promise<{ status: string; outputLocation: string } | null> {
  const candidatePaths = [
    join(NEXUS_WORKSPACE_DIR, "active", taskId, "PROGRESS.md"),
    join(NEXUS_WORKSPACE_DIR, "completed", taskId, "PROGRESS.md"),
    join(NEXUS_WORKSPACE_DIR, "blocked", taskId, "PROGRESS.md"),
  ];

  for (const progressPath of candidatePaths) {
    try {
      const content = await readFile(progressPath, "utf-8");
      const status = parseProgressScalar(content, "status").toUpperCase() || "UNKNOWN";
      const outputLocation = parseProgressScalar(content, "output_location");
      return { status, outputLocation };
    } catch {
      // try next candidate
    }
  }

  return null;
}

function parseRoutingTimeouts(content: string): Partial<Record<RoutingDomain, number>> {
  const parsed: Partial<Record<RoutingDomain, number>> = {};
  const lines = content.split(/\r?\n/);
  let inRoutes = false;
  let currentDomain: RoutingDomain | null = null;

  for (const line of lines) {
    if (!inRoutes) {
    if (/^routes:\s*(?:#.*)?$/.test(line)) inRoutes = true;
    continue;
  }

    if (/^precedence:\s*(?:#.*)?$/.test(line)) break;

    const domainMatch = line.match(/^  ([a-z_]+):\s*(?:#.*)?$/);
    if (domainMatch) {
      const candidate = domainMatch[1];
      currentDomain = Object.prototype.hasOwnProperty.call(ROUTING_TIMEOUT_DEFAULTS, candidate)
        ? (candidate as RoutingDomain)
        : null;
      continue;
    }

    if (!currentDomain) continue;

    const timeoutMatch = line.match(/^    timeout_s:\s*(\d+)\s*(?:#.*)?$/);
    if (timeoutMatch && parsed[currentDomain] == null) {
      parsed[currentDomain] = Number(timeoutMatch[1]);
    }
  }

  return parsed;
}

async function getRoutingTimeouts(): Promise<Record<RoutingDomain, number>> {
  if (routingTimeoutCache) return routingTimeoutCache;

  try {
    const content = await readFile(NEXUS_ROUTING_TABLE_PATH, "utf-8");
    routingTimeoutCache = {
      ...ROUTING_TIMEOUT_DEFAULTS,
      ...parseRoutingTimeouts(content),
    };
    return routingTimeoutCache;
  } catch {
    // Don't cache on failure — allow retry on next call
    return { ...ROUTING_TIMEOUT_DEFAULTS };
  }
}

async function execFileAsync(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }

      const details = [error.message, stderr, stdout].filter(Boolean).join(" | ").trim();
      reject(new Error(details || "execFile failed"));
    });
  });
}

async function startNexusPoller(
  taskId: string,
  chatId: string,
  sendMessage: SendMessageFn,
  route: NexusRouteConfig,
  timeoutMs: number
): Promise<void> {
  if (!taskId || !chatId || nexusPollers.has(taskId)) return;

  const state: NexusPollerState = {
    timer: null,
    expiresAt: Date.now() + timeoutMs,
    lastStatus: "",
    chatId,
    sendMessage,
    route,
    isTickRunning: false,
  };

  const scheduleNextTick = (): void => {
    if (!nexusPollers.has(taskId)) return;
    state.timer = setTimeout(() => {
      void tick();
    }, NEXUS_POLL_INTERVAL_MS);
    if (typeof (state.timer as any)?.unref === "function") {
      (state.timer as any).unref();
    }
  };

  const tick = async (): Promise<void> => {
    if (state.isTickRunning || !nexusPollers.has(taskId)) return;
    state.isTickRunning = true;
    try {
      if (Date.now() > state.expiresAt) {
        stopNexusPoller(taskId);
        await state.sendMessage(state.chatId, `Nexus task ${taskId} timed out while waiting for completion.`).catch(
          () => {}
        );
        return;
      }

      const progress = await readNexusProgress(taskId);
      if (!progress) return;
      if (progress.status === state.lastStatus) return;
      state.lastStatus = progress.status;

      if (progress.status !== "DONE" && progress.status !== "FAILED") return;

      const outputSuffix = progress.outputLocation ? ` Output: ${progress.outputLocation}` : "";
      const prefix = progress.status === "DONE" ? "✅" : "❌";
      await state
        .sendMessage(
          state.chatId,
          `${prefix} Nexus task ${taskId} (${state.route.agent}) finished with status ${progress.status}.${outputSuffix}`
        )
        .catch(() => {});
      stopNexusPoller(taskId);
    } finally {
      state.isTickRunning = false;
      if (nexusPollers.has(taskId)) {
        scheduleNextTick();
      }
    }
  };

  nexusPollers.set(taskId, state);
  void tick();
}

async function dispatchToAgent(context: DispatchContext, taskType: NexusTaskType): Promise<DispatchResult> {
  const route = NEXUS_ROUTE_BY_TASK[taskType];
  const description = sanitizeSingleLine(context.text).slice(0, 1000) || context.text.trim();
  const taskId = generateNexusTaskId();

  try {
    await execFileAsync(
      "bash",
      [
        NEXUS_TASK_CREATE_PATH,
        taskId,
        description,
        route.agent,
        route.complexity,
        route.budgetUsd,
      ],
      NEXUS_CREATE_TIMEOUT_MS
    );

    const routingTimeouts = await getRoutingTimeouts();
    const timeoutMs = (routingTimeouts[route.domain] ?? ROUTING_TIMEOUT_DEFAULTS[route.domain]) * 1000;
    await startNexusPoller(taskId, context.chatId, context.sendMessage, route, timeoutMs);

    return {
      handled: true,
      skipClaude: true,
      response: `Task dispatched to ${route.agent} (${taskId}). I will post completion updates here.`,
    };
  } catch (error) {
    console.warn(`[SMART_DISPATCH] ${taskType} adapter dispatch failed:`, error);
    return {
      handled: true,
      skipClaude: false,
      promptHint: fallbackPromptHint(taskType),
    };
  }
}

async function startCodexPoller(chatId: string, sendMessage: SendMessageFn, taskId: string): Promise<void> {
  if (!chatId || !taskId || codexPollers.has(taskId)) return;

  const initialOffset = await getFileSize(CODEX_DELIVERY_PATH);
  const state: PollerState = {
    offset: initialOffset,
    inode: null,
    timer: null,
    expiresAt: Date.now() + POLL_TIMEOUT_MS,
    seenFingerprints: new Set<string>(),
    taskId,
    isTickRunning: false,
    leftoverLine: "",
    idleTicks: 0,
  };

  const scheduleNextTick = (): void => {
    if (!codexPollers.has(taskId)) return;
    state.timer = setTimeout(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    if (typeof (state.timer as any)?.unref === "function") {
      (state.timer as any).unref();
    }
  };

  const tick = async (): Promise<void> => {
    if (state.isTickRunning || !codexPollers.has(taskId)) return;
    state.isTickRunning = true;
    try {
      const expired = Date.now() > state.expiresAt;

      const { nextOffset, chunk, inode } = await readChunkFromOffset(CODEX_DELIVERY_PATH, state.offset, state.inode);
      state.offset = nextOffset;
      state.inode = inode;
      state.idleTicks = chunk ? 0 : state.idleTicks + 1;
      const flushIdleLeftover = !chunk && state.leftoverLine && state.idleTicks >= 3;

      // Prepend leftover from previous chunk to avoid losing split lines
      const fullChunk = state.leftoverLine + chunk + (flushIdleLeftover ? "\n" : "");
      if (!fullChunk.trim()) {
        // Flush leftover on expiry so it's not lost
        if (expired) { state.leftoverLine = ""; stopCodexPoller(taskId); }
        return;
      }

      const splitLines = fullChunk.split(/\r?\n/);
      // Last element may be incomplete if chunk didn't end on newline
      if (expired) {
        // On expiry, flush everything — no more reads coming
        state.leftoverLine = "";
      } else {
        const endedWithNewline = flushIdleLeftover || chunk.endsWith("\n") || chunk.endsWith("\r\n");
        state.leftoverLine = endedWithNewline ? "" : (splitLines.pop() ?? "");
      }

      const deliveryLines = pickDeliveryLines(splitLines.join("\n"));
      if (deliveryLines.length === 0) {
        if (expired) stopCodexPoller(taskId);
        return;
      }

      let taskCompleted = false;
      const chunkHasTaskId = state.taskId
        ? deliveryLines.some((line) => line.includes(state.taskId))
        : false;
      const chunkHasOtherTaskId = deliveryLines.some(
        (line) => line.includes("codex-task-") && !line.includes(state.taskId)
      );

      for (const deliveryLine of deliveryLines) {
        // Only forward lines that match this task's ID (but always allow completion markers)
        const isCompletion = /\b(DONE|COMPLETE|ERROR|FAILED)\b/i.test(deliveryLine);
        const allowCompletionWithoutId = isCompletion && chunkHasTaskId && !chunkHasOtherTaskId;
        if (state.taskId && !deliveryLine.includes(state.taskId) && !allowCompletionWithoutId) continue;

        const fingerprint = contentFingerprint(deliveryLine);
        if (state.seenFingerprints.has(fingerprint)) continue;
        state.seenFingerprints.add(fingerprint);
        if (state.seenFingerprints.size > 500) {
          let removed = 0;
          const target = Math.floor(state.seenFingerprints.size / 2);
          for (const entry of state.seenFingerprints) {
            state.seenFingerprints.delete(entry);
            removed++;
            if (removed >= target) break;
          }
        }

        const safeLine = deliveryLine.slice(0, 360);
        await sendMessage(chatId, `Codex update: ${safeLine}`).catch(() => {});

        // Stop polling on completion markers
        if (/\b(DONE|COMPLETE|ERROR|FAILED)\b/i.test(deliveryLine)) {
          taskCompleted = true;
        }
      }

      if (taskCompleted || expired) {
        stopCodexPoller(taskId);
        return;
      }
    } finally {
      state.isTickRunning = false;
      if (codexPollers.has(taskId)) {
        scheduleNextTick();
      }
    }
  };

  codexPollers.set(taskId, state);
  void tick();
}

export async function codexAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.CODE) return NOT_HANDLED;

  const description = parseCodeTaskDescription(context.text);
  const taskId = generateTaskId();
  const brief = renderCodexBrief(taskId, description, context.classification.patterns);

  try {
    await mkdir(join(homedir(), ".codex"), { recursive: true });
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
  return dispatchToAgent(context, TaskType.SYSTEM);
}

export async function researchAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.RESEARCH) return NOT_HANDLED;
  return dispatchToAgent(context, TaskType.RESEARCH);
}

export async function forgeAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.AUDIT) return NOT_HANDLED;
  return dispatchToAgent(context, TaskType.AUDIT);
}

export async function calendarAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.CALENDAR) return NOT_HANDLED;
  return dispatchToAgent(context, TaskType.CALENDAR);
}

export async function emailAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.EMAIL) return NOT_HANDLED;
  return dispatchToAgent(context, TaskType.EMAIL);
}

export async function radarAdapter(context: DispatchContext): Promise<DispatchResult> {
  if (context.classification.type !== TaskType.BUSINESS) return NOT_HANDLED;
  return dispatchToAgent(context, TaskType.BUSINESS);
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

export function initDispatch(bot: unknown, sendMessage: SendMessageFn, adapters: AdapterMap = {}) {
  return {
    async handle(text: string, chatId: string): Promise<DispatchResult> {
      if (!isEnabled("FEATURE_SMART_DISPATCH")) {
        return NOT_HANDLED;
      }

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

      const adapter = adapters[classification.type] || ADAPTER_BY_TYPE[classification.type];
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
