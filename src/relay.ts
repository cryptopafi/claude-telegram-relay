/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { run } from "@grammyjs/runner";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname, extname } from "path";
import { homedir } from "os";
import { transcribe } from "./transcribe";
import { processMemoryIntents } from "./memory";
import { extractUrlContent, formatExtractedContent } from "./url-handler";
import { saveToSharedMemory, parseSaveTags } from "./memory-sync";
import { appendToLog } from "./file-logger";
import { factCheck, logFactCheck } from "./fact-checker";
import { isEnabled, getAllFlags } from "./feature-flags";
import { startTrace, endTrace } from "./telemetry";
import { initDispatch } from "./dispatch";
import { initMemoryDB, getMemoryContext, extractAndSaveMemories } from "./memory-fts5";
import {
  processCortexMemoryIntents,
  getCortexContext,
  getCortexRulesContext,
  storeTelegramMessage,
  getCortexProcedures,
  processProcedureTags,
  checkCortexHealth,
  autoSaveToCortex,
  listRulesFromCortex,
} from "./cortex-client";
import { verifyTOTP, isTOTPConfigured, generateTOTPSetup, isHardRule } from "./totp";
import { textToSpeech, cleanupTTS } from "./tts";
import {
  escapeTelegramMarkdownV2,
  keywordsFromTopic,
  parseNexusCommand,
} from "./nexus-command";
import { parseBiRunCommand } from "./bi-command";
import { addRadarSourceFromUrl } from "./radar-add";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { execSync, execFileSync, spawn as nodeSpawn } from "child_process";
import { InputFile } from "grammy";
import { pathToFileURL } from "url";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const MEMORY_DB_PATH = join(RELAY_DIR, "memory.db");

// Directories
const MEMORY_DIR = join(process.env.HOME || "~", ".claude/projects/-Users-pafi/memory");
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const TASKS_FILE = "/Users/pafi/.claude/projects/-Users-pafi/memory/tasks/pafi-tasks.md";
const TASKS_REPO_DIR = "/Users/pafi/.claude/projects/-Users-pafi";
const NEXUS_TASKS_DIR = "/Users/pafi/.nexus/tasks";
const NEXUS_WORKSPACE_DIR = "/Users/pafi/.nexus/workspace";
const NEXUS_SCRIPTS_DIR = "/Users/pafi/.nexus/scripts";
const CANCELLABLE_TASK_STATES = new Set(["IDLE", "DISPATCHED", "CLAIMED", "BLOCKED"]);
const TRANSITION_LOG = "/Users/pafi/.nexus/workspace/logs/state-transitions.log";

// Conversation history for context continuity
const HISTORY_FILE = join(RELAY_DIR, "conversation-history.json");
const MAX_HISTORY_MESSAGES = 20; // Keep last 20 exchanges (10 user + 10 assistant)
const MAX_HISTORY_CHARS = 8000; // Cap total history size to avoid huge prompts

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// CONVERSATION HISTORY
// ============================================================

let chatHistory: ChatMessage[] = [];

async function loadHistory(): Promise<void> {
  try {
    const content = await readFile(HISTORY_FILE, "utf-8");
    chatHistory = JSON.parse(content);
  } catch {
    chatHistory = [];
  }
}

async function addToHistory(role: "user" | "assistant", content: string): Promise<void> {
  chatHistory.push({
    role,
    content: content.substring(0, 2000), // Truncate very long messages
    timestamp: new Date().toISOString(),
  });
  // Keep only the last N messages
  if (chatHistory.length > MAX_HISTORY_MESSAGES) {
    chatHistory = chatHistory.slice(-MAX_HISTORY_MESSAGES);
  }
  await writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
}

function formatHistory(): string {
  if (chatHistory.length === 0) return "";
  let historyText = "CONVERSATION HISTORY (recent messages):\n";
  let totalChars = 0;
  // Build from most recent, stop when we hit the char limit
  const recent = [...chatHistory].reverse();
  const included: string[] = [];
  for (const msg of recent) {
    const line = `${msg.role === "user" ? "Pafi" : "Assistant"}: ${msg.content}`;
    if (totalChars + line.length > MAX_HISTORY_CHARS) break;
    included.unshift(line);
    totalChars += line.length;
  }
  return historyText + included.join("\n");
}

await loadHistory();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const dispatch = initDispatch(bot, sendTelegram);
const memoryContext = initMemoryDB(MEMORY_DB_PATH);
const memoryDb = memoryContext.db;
const memorySessionId = memoryContext.sessionId;
let processedMessageCount = 0;

function memoryContextFor(userMessage: string): string {
  try {
    return getMemoryContext(memoryDb, userMessage);
  } catch (error) {
    console.warn("[MEMORY] getMemoryContext failed:", error);
    return "";
  }
}

function saveConversationMemories(userMessage: string, assistantResponse: string): void {
  try {
    processedMessageCount += 1;
    extractAndSaveMemories(memoryDb, userMessage, assistantResponse, processedMessageCount, memorySessionId);
  } catch (error) {
    console.warn("[MEMORY] extractAndSaveMemories failed:", error);
  }
}

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  if (userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// MODEL ESCALATION
// ============================================================

type ModelLevel = "haiku" | "sonnet" | "opus";

const OPUS_PATTERNS = [
  /\b(design|architect|plan|strategy|strategic)\b/i,
  /\b(review.*code|code.*review)\b/i,
  /\b(tradeoffs?|trade-offs?|pros\s+and\s+cons)\b/i,
  /\b(think\s+deeply|complex\s+analysis)\b/i,
  /\b(redesign|refactor.*entire|system\s+design)\b/i,
  /\b(security\s+review|audit)\b/i,
];

const SONNET_PATTERNS = [
  /\b(implement|build|create|code|write\s+code)\b/i,
  /\b(fix|debug|troubleshoot|solve)\b/i,
  /\b(analyze|research|compare|evaluate)\b/i,
  /\b(explain\s+in\s+detail|how\s+does.*work)\b/i,
  /\b(refactor|optimize|improve)\b/i,
  /\b(script|function|class|api|endpoint)\b/i,
  /\b(install|configure|setup|deploy)\b/i,
];

function detectModelLevel(text: string): ModelLevel {
  // Opus: design, architecture, strategy, complex reasoning
  for (const pattern of OPUS_PATTERNS) {
    if (pattern.test(text)) return "opus";
  }

  // Sonnet: coding, analysis, implementation
  for (const pattern of SONNET_PATTERNS) {
    if (pattern.test(text)) return "sonnet";
  }

  // Default: sonnet for everything — Pafi wants at least Sonnet-level quality
  return "sonnet";
}

// ============================================================
// CORE: Call Claude CLI
// ============================================================

const jobQueue: Array<() => Promise<void>> = [];
let isJobQueueRunning = false;

async function drainJobQueue(): Promise<void> {
  if (isJobQueueRunning) return;
  isJobQueueRunning = true;
  try {
    while (jobQueue.length > 0) {
      const nextJob = jobQueue.shift();
      if (nextJob) {
        await nextJob();
      }
    }
  } finally {
    isJobQueueRunning = false;
  }
}

function enqueueClaudeJob<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    jobQueue.push(async () => {
      try {
        resolve(await job());
      } catch (error) {
        reject(error);
      }
    });
    void drainJobQueue();
  });
}

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; model?: ModelLevel }
): Promise<string> {
  const model = options?.model || detectModelLevel(prompt);
  const args = [CLAUDE_PATH, "-p", prompt, "--model", model];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`[ESCALATION] Model: ${model} for prompt: ${prompt.substring(0, 80)}...`);

  console.log(`Calling Claude (${model}): ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error (exit " + exitCode + "):", "stdout:", output.substring(0,500), "stderr:", stderr.substring(0,500));
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// TOTP PENDING STATE
// ============================================================

let pendingTOTP: {
  ruleId: string;
  action: string;
  expiresAt: number;
} | null = null;

// ============================================================
// TASK MANAGEMENT (Telegram commands)
// ============================================================

function getActiveTaskLines(content: string, limit = 10): string[] {
  const lines = content.split("\n");
  const tasks: string[] = [];
  let inActiveSection = false;
  let idx = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+Active\b/i.test(line)) { inActiveSection = true; continue; }
    if (inActiveSection && /^##\s+/.test(line)) break;
    if (!inActiveSection) continue;
    if (!line.includes("- [ ]")) continue;

    // Strip markdown: remove "- [ ]" and **bold**
    let clean = line
      .replace(/^-\s*\[.\]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

    // Extract project from trailing (Nx Name) / (Bx Name) pattern, then remove from text
    const projMatch = clean.match(/\(([A-Z]\d+\s+[^)]+)\)\s*$/);
    let project = "";
    if (projMatch) {
      // e.g. "N2 Delphi" → "Delphi"
      project = projMatch[1].replace(/^[A-Z]\d+\s+/, "").trim();
      clean = clean.replace(/\s*\([A-Z]\d+[^)]*\)\s*$/, "").trim();
    }

    // Assign color by urgency
    const low = clean.toLowerCase();
    let bullet: string;
    if (/gmail|#3|landing page|agency|echelon|delphi.*bug|bi infra|pending_digest/i.test(low)) {
      bullet = "🔴";
    } else if (/codex|research|fts5|media handling|mission control|playwright|nexus comms/i.test(low)) {
      bullet = "🟡";
    } else {
      bullet = "🔵";
    }

    idx++;
    const projectTag = project ? ` (${project})` : "";
    tasks.push(`${bullet} ${idx}. ${clean}${projectTag}`);
    if (tasks.length >= limit) break;
  }
  return tasks;
}

async function sendTelegram(chatId: string, message: string): Promise<void> {
  if (!chatId) return;
  await bot.api.sendMessage(chatId, message);
}

async function runNexusResearch(
  chatId: string,
  topic: string,
  depth: "standard" | "deep",
  mode: "manual" | "auto" = "manual"
): Promise<void> {
  const scriptPath = join(process.env.HOME || "~", ".nexus", "echelon", "nexus-unified.sh");
  const env = {
    ...process.env,
    NEXUS_DEPTH: depth,
    NEXUS_MODE: "1",
    CORTEX_LOCAL_URL: process.env.CORTEX_LOCAL_URL || process.env.CORTEX_URL || "http://localhost:6400",
    ECH_TOPIC_KEYWORDS: keywordsFromTopic(topic),
  };

  try {
    await Bun.file(scriptPath).stat();
  } catch {
    await bot.api.sendMessage(chatId, `❌ NEXUS script lipsă: ${scriptPath}`);
    return;
  }

  const proc = nodeSpawn(
    "/bin/bash",
    [scriptPath, "--input", topic.slice(0, 200), "--depth", depth, "--mode", mode],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    }
  );

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  const timeoutMs = depth === "deep" ? 600_000 : 300_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(`[NEXUS] Research timed out after ${Math.round(timeoutMs / 1000)}s`);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000);
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await bot.api.sendMessage(chatId, `❌ NEXUS spawn failed: ${message}`);
    return null;
  });

  if (exitCode === null) {
    return;
  }

  if (timedOut) {
    stdout = JSON.stringify({ ok: false, error: "Research timed out" });
    stderr = "";
  }

  if (exitCode !== 0 && !timedOut) {
    const failure = (stderr.trim() || stdout.trim() || `exit ${exitCode}`).slice(0, 500);
    await bot.api.sendMessage(chatId, `❌ NEXUS research a eșuat: ${failure}`);
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(stdout);
  } catch {
    const fallback = stdout.trim().slice(0, 500) || "invalid JSON output";
    await bot.api.sendMessage(chatId, `⚠️ NEXUS finalizat, dar outputul nu a putut fi parsat corect: ${fallback}`);
    return;
  }

  if (payload?.ok === false) {
    const errMsg = String(payload?.error || "research failed").slice(0, 400);
    await bot.api.sendMessage(chatId, `❌ NEXUS eșuat: ${errMsg}`);
    return;
  }

  const summary = String(payload?.telegram_summary || payload?.summary || "Research complet.");
  const safeSummary = escapeTelegramMarkdownV2(summary.slice(0, 400));
  await bot.api.sendMessage(chatId, `🧠 *Nexus Research*\n\n${safeSummary}`, {
    parse_mode: "MarkdownV2",
  });

  const htmlPath = String(payload?.html_path || "").trim();
  if (!htmlPath) {
    return;
  }

  try {
    await Bun.file(htmlPath).stat();
    await bot.api.sendDocument(chatId, new InputFile(htmlPath), {
      caption: topic.slice(0, 200) || "Nexus report",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await bot.api.sendMessage(chatId, `⚠️ HTML report indisponibil: ${message.slice(0, 200)}`);
  }
}

async function handleNexusCommand(ctx: Context, chatId: string, text: string): Promise<boolean> {
  const parsed = parseNexusCommand(text);
  if (!parsed) {
    return false;
  }

  if (!parsed.topic) {
    await ctx.reply("Folosire:\n/nexus [topic]\n/nexus deep [topic]\n/nexus auto [topic]\n/nexus auto deep [topic]");
    return true;
  }

  const rawInput = parsed.topic.slice(0, 200);
  await ctx.reply(`Research în curs pentru: ${rawInput}`);
  await runNexusResearch(chatId, rawInput, parsed.depth, parsed.mode);

  return true;
}

type RadarAddResult =
  | { ok: true; domain: string; title: string }
  | { ok: false; error: string };

function detectRadarSourceType(rawUrl: string): "github" | "youtube" | "reddit" | "website" {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return "github";
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be") return "youtube";
  if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) return "reddit";
  return "website";
}

async function runRadarAdd(url: string, cortexUrl: string): Promise<RadarAddResult> {
  const scriptPath = join(process.env.HOME || "~", ".nexus", "echelon", "source-discover.py");
  const radarDbPath = join(process.env.HOME || "~", ".nexus", "radar", "radar-db.js");
  const proc = nodeSpawn("python3", [scriptPath, "--url", url, "--cortex-url", cortexUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CORTEX_LOCAL_URL: cortexUrl },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 1000);
  }, 30_000);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (exitCode !== 0) {
    return { ok: false, error: (stderr.trim() || `exit ${exitCode ?? "?"}`).slice(0, 300) };
  }

  let payload: any;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: "invalid JSON response from source-discover.py" };
  }

  if (!payload?.ok || !payload?.profile_path) {
    return { ok: false, error: String(payload?.error || stderr.trim() || "source discovery failed").slice(0, 300) };
  }

  let profile: any = {};
  try {
    profile = JSON.parse(await readFile(String(payload.profile_path), "utf-8"));
  } catch {
    profile = {};
  }

  const title = String(profile?.title || payload.domain || new URL(url).hostname);
  const radarDb = await import(pathToFileURL(radarDbPath).href);
  const addSource = radarDb.addSource || radarDb.default?.addSource;
  if (typeof addSource !== "function") {
    return { ok: false, error: "radar-db addSource unavailable" };
  }

  try {
    addSource({
      type: detectRadarSourceType(url),
      url,
      title,
      project_slugs: [],
      status: "active",
      cortex_collection: "research",
      discovered_via: "manual",
      tier: 2,
      frequency: "daily",
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
    return { ok: false, error: `Radar add eșuat: ${msg}` };
  }

  return { ok: true, domain: String(payload.domain || new URL(url).hostname), title };
}

async function handleRadarAddCommand(ctx: Context, text: string): Promise<boolean> {
  if (!text.trim().startsWith("/radar-add")) {
    return false;
  }

  const urlToken = text.trim().split(/\s+/, 3)[1] || "";
  if (!urlToken || urlToken.length > 500) {
    await ctx.reply("❌ URL invalid");
    return true;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlToken);
  } catch {
    await ctx.reply("❌ URL invalid");
    return true;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    await ctx.reply("❌ URL invalid");
    return true;
  }

  await ctx.reply(`Analizez sursa pentru Radar: ${parsedUrl.hostname}`);
  const result = await runRadarAdd(parsedUrl.toString(), process.env.CORTEX_LOCAL_URL || process.env.CORTEX_URL || "http://localhost:6400");
  if (result.ok === false) {
    await ctx.reply(`⚠️ Radar: nu am putut procesa ${parsedUrl.toString()} — ${result.error}`);
    return true;
  }

  await ctx.reply(`✅ Radar: ${result.domain} adăugat (${result.title})`);
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function handleRadarLightAddCommand(ctx: Context, text: string): Promise<boolean> {
  const match = text.trim().match(/^\/radar(?:@[\w_]+)?\s+add(?:\s+(.+))?$/i);
  if (!match) {
    return false;
  }

  const urlToken = (match[1] || "").trim().split(/\s+/, 1)[0] || "";
  if (!urlToken) {
    await ctx.reply("Folosire: /radar add https://example.com/feed");
    return true;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlToken);
  } catch {
    await ctx.reply("❌ URL invalid");
    return true;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    await ctx.reply("❌ URL invalid");
    return true;
  }

  await ctx.reply(`Analizez sursa Radar: ${parsedUrl.hostname}`);
  const addResult = await addRadarSourceFromUrl(parsedUrl.toString());

  if (addResult.ok === false) {
    if (addResult.code === "invalid_url") {
      await ctx.reply("❌ URL invalid");
      return true;
    }
    if (addResult.code === "exists") {
      await ctx.reply("⚠️ URL deja există în radar-sources.yaml");
      return true;
    }
    await ctx.reply(`⚠️ Radar add eșuat: ${addResult.error}`);
    return true;
  }

  const confirmation = [
    "📡 <b>Sursă adăugată în Radar</b>",
    "",
    `📌 ${escapeHtml(addResult.entry.name)}`,
    `🔗 ${escapeHtml(addResult.entry.url)}`,
    `📂 Tip: ${escapeHtml(addResult.entry.type)}`,
    `🏷️ Vertical: ${escapeHtml(addResult.entry.vertical)}`,
    "",
    "<i>Activ la următorul sync. Editează vertical în radar-sources.yaml dacă e greșit.</i>",
  ].join("\n");

  await ctx.reply(confirmation, { parse_mode: "HTML" });
  return true;
}

async function getEnabledProjectCount(configPath: string, slug: string | null): Promise<number> {
  try {
    const rawConfig = await Bun.file(configPath).text();
    const parsed = JSON.parse(rawConfig) as {
      projects?: Array<{ slug?: unknown; enabled?: unknown }>;
    };

    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const expectedSlug = slug ? slug.toLowerCase() : null;
    const enabledCount = projects.filter((project) => {
      if (!project || project.enabled !== true) return false;
      if (!expectedSlug) return true;
      return typeof project.slug === "string" && project.slug.toLowerCase() === expectedSlug;
    }).length;

    return Math.max(enabledCount, 1);
  } catch (error) {
    console.warn("[BI] Failed to parse bi-config.json, using conservative timeout:", error);
    return 5;
  }
}

async function handleBiRunCommand(ctx: Context, chatId: string, text: string): Promise<boolean> {
  const commandMatch = text.trim().match(/^\/bi(?:-run|_run)(?:@[\w_]+)?(?:\s+(.+))?$/i);
  if (!commandMatch) {
    return false;
  }

  const rawArg = (commandMatch[1] || "").trim();
  const parsed = parseBiRunCommand(text);
  if (!parsed) {
    await ctx.reply(rawArg ? "❌ Slug invalid. Folosire: /bi-run albastru" : "Folosire:\n/bi-run\n/bi-run albastru");
    return true;
  }

  const schedulerScript = join(process.env.HOME || "~", ".nexus", "bi-scheduler.sh");
  const biConfigPath = join(process.env.HOME || "~", ".nexus", "bi-config.json");
  try {
    await Bun.file(schedulerScript).stat();
  } catch {
    await ctx.reply(`❌ BI scheduler lipsește: ${schedulerScript}`);
    return true;
  }

  const projectCount = await getEnabledProjectCount(biConfigPath, parsed.mode === "project" ? parsed.slug : null);
  const timeoutMs = Math.min(Math.max(projectCount * 8 * 60 * 1000, 10 * 60 * 1000), 60 * 60 * 1000);
  console.log(`[BI] timeout=${Math.round(timeoutMs / 60000)}min projects=${projectCount}`);

  const args = parsed.mode === "project" ? ["--project", parsed.slug] : ["--all"];
  await ctx.reply(parsed.mode === "project" ? `Pornesc BI pentru ${parsed.slug}...` : "Pornesc BI pentru toate proiectele...");

  const proc = nodeSpawn("/bin/bash", [schedulerScript, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TELEGRAM_PAFI_CHAT_ID: process.env.TELEGRAM_PAFI_CHAT_ID || process.env.TELEGRAM_USER_ID || chatId,
    },
  });

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";

  const flushLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    await ctx.reply(`BI: ${trimmed}`);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    const textChunk = chunk.toString();
    stdout += textChunk;
    lineBuffer += textChunk;
    const pieces = lineBuffer.split(/\r?\n/);
    lineBuffer = pieces.pop() || "";
    for (const piece of pieces) {
      void flushLine(piece);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 1000);
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ BI spawn failed: ${message}`);
    return null;
  });

  if (lineBuffer.trim()) {
    await flushLine(lineBuffer);
  }

  if (exitCode === null) {
    return true;
  }

  if (exitCode !== 0) {
    const failure = (stderr.trim() || stdout.trim() || `exit ${exitCode}`).slice(0, 500);
    await ctx.reply(`❌ BI run a eșuat: ${failure}`);
    return true;
  }

  await ctx.reply("✅ BI run complet.");
  return true;
}

async function gitCommitAndPush(file: string, message: string): Promise<void> {
  const relativePath = file.startsWith(TASKS_REPO_DIR + "/")
    ? file.slice(TASKS_REPO_DIR.length + 1)
    : file;

  try {
    execSync(`git -C "${TASKS_REPO_DIR}" add "${relativePath}"`, { stdio: "pipe" });
    const status = execSync(`git -C "${TASKS_REPO_DIR}" status --short "${relativePath}"`, {
      encoding: "utf-8",
    }).trim();
    if (!status) return;

    execSync(`git -C "${TASKS_REPO_DIR}" commit -m ${JSON.stringify(message)}`, { stdio: "pipe" });
    execSync(`git -C "${TASKS_REPO_DIR}" push origin main`, { stdio: "pipe", timeout: 30000 });
  } catch (error) {
    console.error("Git push failed:", error);
  }
}

function sanitizeCancelTaskId(rawTaskId: string): string {
  return rawTaskId.replace(/<[^>]*>/g, "").trim().slice(0, 50);
}

function readTaskProgress(taskId: string): { path: string; content: string } | null {
  const candidatePaths = [
    // Phase 2 workspace paths (primary)
    join(NEXUS_WORKSPACE_DIR, "active", taskId, "PROGRESS.md"),
    join(NEXUS_WORKSPACE_DIR, "completed", taskId, "PROGRESS.md"),
    // Legacy paths (fallback)
    join(NEXUS_TASKS_DIR, "active", taskId, "PROGRESS.md"),
    join(NEXUS_TASKS_DIR, "blocked", taskId, "PROGRESS.md"),
    join(NEXUS_TASKS_DIR, "completed", taskId, "PROGRESS.md"),
  ];

  for (const path of candidatePaths) {
    try {
      return { path, content: readFileSync(path, "utf-8") };
    } catch {
      // Try next path
    }
  }

  return null;
}

function getProgressState(progressContent: string): string {
  const stateMatch = progressContent.match(/^\s*status:\s*"?([A-Z_]+)"?\s*$/m);
  return stateMatch?.[1] || "UNKNOWN";
}

async function handleTaskCommand(text: string, chatId: string): Promise<boolean> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Detect: list tasks
  if (lower === "tasks" || lower === "/tasks") {
    const content = readFileSync(TASKS_FILE, "utf-8");
    const lines = getActiveTaskLines(content, 30);
    const msg =
      lines.length > 0
        ? `📋 Active Tasks (${lines.length}):\n${lines.join("\n")}`
        : "✅ No active tasks!";
    await sendTelegram(chatId, msg);
    return true;
  }

  // Detect: create Phase 2 task — "/task <description>"
  const taskCreateMatch = trimmed.match(/^\/task\s+(.+)$/i);
  if (taskCreateMatch) {
    const description = taskCreateMatch[1].trim();
    if (!description) {
      await sendTelegram(chatId, "Folosire: /task <descriere task>");
      return true;
    }
    try {
      // Step 1: classify — output format: "domain=X agent=Y complexity=Z"
      // Use execFileSync with argv array to prevent shell injection from Telegram input
      const classifyOut = execFileSync(
        "bash",
        [join(NEXUS_SCRIPTS_DIR, "nexus-task-classify.sh"), description],
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      const domainMatch = classifyOut.match(/domain=(\S+)/);
      const agentMatch = classifyOut.match(/agent=(\S+)/);
      const complexityMatch = classifyOut.match(/complexity=(\S+)/);
      const domain = domainMatch?.[1] || "ops";
      const agent = agentMatch?.[1] || "genie";
      const complexity = complexityMatch?.[1] || "medium";
      if (!domainMatch || !agentMatch) {
        await sendTelegram(chatId, `⚠️ Classification failed: ${classifyOut}`);
        return true;
      }
      // Step 2: generate task_id and budget
      const taskId = `task-${Date.now()}`;
      const budgetMap: Record<string, string> = { low: "0.50", medium: "2.00", high: "5.00" };
      const budget = budgetMap[complexity] || "2.00";
      // Step 3: create — args: task_id description assigned_agent complexity budget_usd
      // Use execFileSync with argv array to prevent shell injection
      execFileSync(
        "bash",
        [join(NEXUS_SCRIPTS_DIR, "nexus-task-create.sh"), taskId, description, agent, complexity, budget],
        { encoding: "utf-8", timeout: 10000 }
      );
      await sendTelegram(chatId, `✅ Task created: ${taskId}\nDomain: ${domain} | Agent: ${agent} | Complexity: ${complexity}\nBudget: $${budget} | Status: DISPATCHED`);
    } catch (err: any) {
      await sendTelegram(chatId, `❌ Task creation failed: ${err.message?.slice(0, 200)}`);
    }
    return true;
  }

  // Detect: cancel task — "/cancel <task-id>"
  const cancelMatch = trimmed.match(/^\/cancel(?:\s+(.+))?$/i);
  if (cancelMatch) {
    const rawTaskId = cancelMatch[1] || "";
    const taskId = sanitizeCancelTaskId(rawTaskId);

    if (!taskId) {
      await sendTelegram(chatId, "Folosire: /cancel <task-id>");
      return true;
    }

    if (!/^[A-Za-z0-9-]+$/.test(taskId)) {
      await sendTelegram(chatId, "Invalid task-id. Use only alphanumeric characters and hyphen.");
      return true;
    }

    const progress = readTaskProgress(taskId);
    if (!progress) {
      await sendTelegram(chatId, `Task ${taskId} not found.`);
      return true;
    }

    const currentState = getProgressState(progress.content);
    if (!CANCELLABLE_TASK_STATES.has(currentState)) {
      await sendTelegram(chatId, `Cannot cancel task in ${currentState} state`);
      return true;
    }

    const now = new Date().toISOString();
    let updatedProgress = progress.content.replace(/^\s*status:\s*.*$/m, "status: CANCELLED");
    if (/^\s*updated_at:\s*.*$/m.test(updatedProgress)) {
      updatedProgress = updatedProgress.replace(/^\s*updated_at:\s*.*$/m, `updated_at: "${now}"`);
    } else {
      updatedProgress = `${updatedProgress.trimEnd()}\nupdated_at: "${now}"\n`;
    }

    writeFileSync(progress.path, updatedProgress);

    // Append to state transition log (L-001 fix)
    try {
      const logDir = dirname(TRANSITION_LOG);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(TRANSITION_LOG, `${now}\t${taskId}\t${currentState}\tCANCELLED\tuser:pafi\n`);
    } catch (_) { /* transition log is best-effort */ }

    await sendTelegram(chatId, `✅ Task ${taskId} cancelled.`);
    return true;
  }

  // Detect: mark done — "gata cu X", "done X", "am terminat X"
  const doneMatch = trimmed.match(/^(gata cu|done|am terminat)\s+(.+)$/i);
  if (doneMatch) {
    const taskText = doneMatch[2].trim();
    const content = readFileSync(TASKS_FILE, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const today = new Date().toISOString().split("T")[0];
    const updated = lines.map((line) => {
      if (found) return line;
      if (line.includes("- [ ]") && line.toLowerCase().includes(taskText.toLowerCase())) {
        found = true;
        const marked = line.replace("- [ ]", "- [x]");
        if (/\(\d{4}-\d{2}-\d{2}\)\s*$/.test(marked)) return marked;
        return `${marked} (${today})`;
      }
      return line;
    });

    if (found) {
      writeFileSync(TASKS_FILE, updated.join("\n"));
      await gitCommitAndPush(TASKS_FILE, `Task done via Telegram: ${taskText}`);
      await sendTelegram(chatId, `✅ Task marcat ca done: "${taskText}"`);
    } else {
      await sendTelegram(chatId, `⚠️ Nu am gasit task cu "${taskText}". Verifica cu /tasks.`);
    }
    return true;
  }

  // Detect: add task — "adaugă task X", "add task X", "nou task X"
  const addMatch = trimmed.match(/^(adaug(?:ă|a)\s+task|add\s+task|nou\s+task)\s+(.+)$/i);
  if (addMatch) {
    const taskText = addMatch[2].trim();
    const content = readFileSync(TASKS_FILE, "utf-8");
    const updated = /^## Active\s*$/m.test(content)
      ? content.replace(/^## Active\s*$/m, `## Active\n- [ ] ${taskText}`)
      : `${content.trimEnd()}\n\n## Active\n- [ ] ${taskText}\n`;

    writeFileSync(TASKS_FILE, updated);
    await gitCommitAndPush(TASKS_FILE, `Add task via Telegram: ${taskText}`);
    await sendTelegram(chatId, `✅ Task adaugat: "${taskText}"`);
    return true;
  }

  return false;
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

function startTypingKeepalive(ctx: Context): ReturnType<typeof setInterval> {
  ctx.replyWithChatAction("typing").catch(() => {});
  return setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
}

// /totp_setup command - generate new TOTP secret (admin only)
bot.command("totp_setup", async (ctx) => {
  if (isTOTPConfigured()) {
    await ctx.reply("TOTP deja configurat. Șterge TOTP_SECRET din .env pentru a regenera.");
    return;
  }
  const setup = generateTOTPSetup();
  await ctx.reply(setup.qrText);
});

// /rules command - list rules directly from Cortex API (no Claude CLI cost)
bot.command("rules", async (ctx) => {
  const arg = ctx.match?.trim()?.toLowerCase();
  if (arg === "hard" || arg === "standard" || arg === "soft" || arg === "temporary") {
    const response = await listRulesFromCortex(arg);
    await sendResponse(ctx, response);
  } else if (arg === "all") {
    const response = await listRulesFromCortex();
    await sendResponse(ctx, response);
  } else {
    await ctx.reply(
      "📋 Comenzi reguli:\n" +
      "/rules hard - Reguli HARD (necesită TOTP)\n" +
      "/rules standard - Reguli STANDARD\n" +
      "/rules soft - Reguli SOFT\n" +
      "/rules temporary - Reguli temporare\n" +
      "/rules all - Toate regulile\n" +
      "/rule_modify RULE_ID - Modifică o regulă"
    );
  }
});

// /model command - view or switch OpenClaw agent models
bot.command("model", async (ctx) => {
  await ctx.replyWithChatAction("typing");

  const arg = ctx.match?.trim() || "";
  const MODEL_SWITCH_SCRIPT = join(process.env.HOME || "~", ".openclaw/scripts/model-switch.sh");

  // Parse args: empty or "status" → status; "agent alias" → switch
  let scriptArgs: string[];
  if (arg === "" || arg.toLowerCase() === "status") {
    scriptArgs = ["status"];
  } else {
    const parts = arg.split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply(
        "Folosire:\n" +
        "/model — status curent\n" +
        "/model status — status curent\n" +
        "/model <agent> <alias> — schimbă modelul agentului\n\n" +
        "Exemplu: /model tech haiku"
      );
      return;
    }
    scriptArgs = [parts[0], parts[1]];
  }

  try {
    const proc = spawn(["bash", MODEL_SWITCH_SCRIPT, ...scriptArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const errMsg = stderr.trim() || `Script exited with code ${exitCode}`;
      await ctx.reply(`Eroare model-switch:\n\`${errMsg}\``);
      return;
    }

    const output = stdout.trim();
    if (!output) {
      await ctx.reply("Script rulat, fara output.");
      return;
    }

    // Wrap in monospace for the status table
    await sendResponse(ctx, "```\n" + output + "\n```");
  } catch (error) {
    console.error("Model switch error:", error);
    await ctx.reply(`Eroare la rularea script-ului: ${(error as Error).message}`);
  }
});

// /rule_modify command - modify a rule (HARD rules need TOTP)
bot.command("rule_modify", async (ctx) => {
  const ruleId = ctx.match?.trim().toUpperCase();
  if (!ruleId) {
    await ctx.reply("Folosire: /rule_modify RULE_ID\nExemplu: /rule_modify SEC-H-001");
    return;
  }

  if (isHardRule(ruleId)) {
    if (!isTOTPConfigured()) {
      await ctx.reply("TOTP nu e configurat. Rulează /totp_setup mai întâi.");
      return;
    }
    // Set pending state - user has 90 seconds to provide code
    pendingTOTP = {
      ruleId,
      action: "modify",
      expiresAt: Date.now() + 90_000,
    };
    await ctx.reply(`🔐 Regula ${ruleId} este HARD. Introdu codul TOTP din Google Authenticator (ai 90 secunde):`);
    return;
  }

  // Non-HARD rules: proceed directly
  await ctx.reply(`Descrie modificarea pentru ${ruleId}:`);
});

// ============================================================
// NEXUS APPROVAL GATE — V/G/R Response Handler
// ============================================================
const APPROVAL_RESPONSE_PATH = join(
  process.env.HOME || "~",
  ".nexus/workspace/intel/APPROVAL-RESPONSE.md"
);

async function handleApprovalResponse(ctx: Context, text: string): Promise<boolean> {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();

  // Only match approval patterns: OK/GO/APPROVE, REJECT/VETO, REDIRECT <agent>
  const isApprove = /^(OK|GO|APPROVE)\b/i.test(trimmed);
  const isReject = /^(REJECT|VETO)\b/i.test(trimmed);
  const isRedirect = /^REDIRECT\b/i.test(trimmed);

  if (!isApprove && !isReject && !isRedirect) {
    return false;
  }

  // Check if there's a pending approval
  let pending = "";
  try {
    pending = await readFile(APPROVAL_RESPONSE_PATH, "utf-8");
  } catch {
    return false; // No file = no pending approval
  }

  if (!pending.includes("status: PENDING")) {
    return false; // Not in PENDING state
  }

  // Extract task_id from existing PENDING response
  const taskIdMatch = pending.match(/task_id:\s*"?([^"\n]+)"?/);
  const taskId = taskIdMatch?.[1] || "unknown";

  const now = new Date().toISOString();
  let decision = "";
  let status = "";
  let reason = "";
  let redirectAgent = "";

  if (isApprove) {
    decision = "GO";
    status = "APPROVED";
  } else if (isReject) {
    decision = "VETO";
    status = "REJECTED";
    reason = trimmed.replace(/^(REJECT|VETO)\s*/i, "").trim() || "";
  } else if (isRedirect) {
    decision = "REDIRECT";
    status = "REDIRECTED";
    const parts = trimmed.replace(/^REDIRECT\s*/i, "").trim().split(/\s+/);
    redirectAgent = parts[0] || "";
    reason = parts.slice(1).join(" ") || "";
  }

  // Sanitize user-derived fields to prevent YAML injection (strip quotes, newlines)
  const safeReason = reason.replace(/["\n\r]/g, " ").trim();
  const safeRedirect = redirectAgent.replace(/[^a-z0-9_-]/gi, "").trim();

  // Write APPROVAL-RESPONSE.md (NEXUS-MESSAGING-PROTOCOL envelope)
  const response = `---
msg_type: approval
from: relay
to: genie
correlation_id: "${taskId}"
timestamp: "${now}"
in_reply_to: "${taskId}"
---
status: ${status}
task_id: "${taskId}"
decision: "${decision}"
responded_by: "pafi"
responded_via: "telegram"
reason: "${safeReason}"
redirect_agent: "${safeRedirect}"
`;

  await writeFile(APPROVAL_RESPONSE_PATH, response);

  // Confirm to Pafi
  const emoji = decision === "GO" ? "✅" : decision === "VETO" ? "❌" : "↪️";
  const extra = reason ? ` — ${reason}` : "";
  const agentNote = redirectAgent ? ` → ${redirectAgent}` : "";
  await ctx.reply(`${emoji} Approval ${decision} for task ${taskId}${agentNote}${extra}`);

  console.log(`[APPROVAL] ${decision} task=${taskId} redirect=${redirectAgent} reason=${reason}`);
  return true;
}

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const messageId = ctx.message.message_id || Date.now();
  const userId = ctx.from?.id?.toString() || "unknown";
  const featureFlags = getAllFlags();
  const activeFeatures = Object.entries(featureFlags)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  startTrace(messageId);

  const chatId = ctx.chat?.id?.toString() || "";
  console.log(`Message: ${text.substring(0, 50)}...`);
  const typingInterval = startTypingKeepalive(ctx);
  let traceBuildPromptMs = 0;
  let traceFactCheckMs = 0;
  let traceModel = "unknown";
  let traceTokensUsed = estimateTokens(text);
  let traceError: string | null = null;
  let traceMessageType = "text";
  let dispatchPromptHint = "";

  await ctx.react("👀").catch(() => {});

  try {
    // Task command interception (skip Claude call when handled)
    if (await handleTaskCommand(text, chatId)) {
      traceMessageType = "command";
      return;
    }

    if (await handleNexusCommand(ctx, chatId, text)) {
      traceMessageType = "command";
      return;
    }

    if (await handleRadarLightAddCommand(ctx, text)) {
      traceMessageType = "command";
      return;
    }

    if (await handleRadarAddCommand(ctx, text)) {
      traceMessageType = "command";
      return;
    }

    if (await handleBiRunCommand(ctx, chatId, text)) {
      traceMessageType = "command";
      return;
    }

    // NexusOS approval gate response (OK/REJECT/REDIRECT)
    if (await handleApprovalResponse(ctx, text)) {
      traceMessageType = "command";
      clearInterval(typingInterval);
      return;
    }

    // /ingest-deep command handler - always uses Opus
    if (text?.startsWith("/ingest-deep") || text?.startsWith("/ingest_deep")) {
      const msg = ctx.message;
      const url = (text.startsWith("/ingest-deep")
        ? text.replace("/ingest-deep", "")
        : text.replace("/ingest_deep", "")).trim();

      if (!url && !msg.document && !msg.photo) {
        await ctx.reply("❓ Trimite un URL:\n/ingest-deep https://youtube.com/watch?v=xxx");
        return;
      }

      await ctx.reply("⚙️ SuperInsight Deep (Opus) pornit...");

      const ingestScript = `${process.env.HOME}/.openclaw/scripts/ingest-smart.sh`;
      const target = url || "[file-attachment]";
      const proc = nodeSpawn("bash", [ingestScript, target, "--deep"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TELEGRAM_TRIGGER: "true", CHAT_ID: String(chatId) },
      });

      proc.stderr?.on("data", (d: Buffer) => {
        console.error("[ingest-deep]", d.toString());
      });

      proc.on("close", async (code: number | null) => {
        if (code === 0) {
          await ctx.reply("✅ SuperInsight Deep complet. Verifică @claudemacm4_bot.");
        } else {
          await ctx.reply(`❌ SuperInsight Deep eșuat (exit ${code ?? "?"}). Verifică logs.`);
        }
      });

      return;
    }

    // /ingest command handler
    if (text?.startsWith("/ingest")) {
      const msg = ctx.message;
      const normalizedText = text
        ?.replace(/\u2014/g, "--")
        ?.replace(/\u2013/g, "--")
        ?.replace(/\u2012/g, "--");
      const forceOpus =
        normalizedText?.includes("--deep") || normalizedText?.includes("--opus");
      const urlPart = normalizedText
        ?.replace("/ingest", "")
        ?.replace(/--deep|--opus/gi, "")
        ?.trim();
      const url = urlPart || "";

      if (!url && !msg.document && !msg.photo) {
        await ctx.reply(
          "❓ Trimite un URL sau atașează un fișier cu /ingest\nEx: /ingest https://youtube.com/watch?v=xxx\nSau: /ingest --deep https://... (forțează Opus)"
        );
        return;
      }

      await ctx.reply("⚙️ SuperInsight pornit...");

      const target = url || "[file-attachment]";
      const opusFlag = forceOpus ? "--deep" : "";
      const ingestScript = `${process.env.HOME}/.openclaw/scripts/ingest-smart.sh`;
      const args = [ingestScript, target, opusFlag].filter(Boolean);

      const proc = nodeSpawn("bash", args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TELEGRAM_TRIGGER: "true", CHAT_ID: String(chatId) },
      });

      let output = "";
      proc.stdout?.on("data", (d: Buffer) => {
        output += d.toString();
      });
      proc.stderr?.on("data", (d: Buffer) => {
        console.error("[ingest]", d.toString());
      });

      proc.on("close", async (code: number | null) => {
        if (code === 0) {
          await ctx.reply("✅ SuperInsight complet. Verifică @claudemacm4_bot pentru output.");
        } else {
          await ctx.reply(`❌ SuperInsight eșuat (exit ${code ?? "?"}). Verifică logs.`);
        }
      });

      return;
    }

    // Check for pending TOTP verification
    if (pendingTOTP && /^\d{6}$/.test(text.trim())) {
      if (Date.now() > pendingTOTP.expiresAt) {
        pendingTOTP = null;
        await ctx.reply("Codul TOTP a expirat. Folosește /rule_modify din nou.");
        return;
      }

      if (verifyTOTP(text.trim())) {
        const ruleId = pendingTOTP.ruleId;
        pendingTOTP = null;
        await ctx.reply(`TOTP verificat. Descrie modificarea pentru ${ruleId}:`);
        // The next message will be handled as a normal rule modification
      } else {
        await ctx.reply("Cod TOTP incorect. Încearcă din nou (sau /rule_modify pentru a reîncepe).");
      }
      return;
    }

    if (isEnabled("FEATURE_SMART_DISPATCH")) {
      const dispatchResult = await dispatch.handle(text, chatId);
      if (dispatchResult.promptHint) {
        dispatchPromptHint = dispatchResult.promptHint;
      }
      if (dispatchResult.skipClaude) {
        if (dispatchResult.response) {
          await sendTelegram(chatId, dispatchResult.response);
        }
        return;
      }
    }

    await addToHistory("user", text);
    await appendToLog("user", text);
    await storeTelegramMessage("user", text);

    // Gather context: conversation history + URLs + Cortex + procedures
    const [sharedMemory, urlContents, cortexContext, cortexRules, cortexProcedures] = await Promise.all([
      loadSharedMemory(),
      extractUrlContent(text),
      getCortexContext(text),
      getCortexRulesContext(),
      getCortexProcedures(text),
    ]);

    const history = formatHistory();
    const urlContext = formatExtractedContent(urlContents);
    const buildPromptStart = Date.now();
    let enrichedPrompt = buildPrompt(text, sharedMemory, cortexContext, cortexRules, dispatchPromptHint);
    if (cortexProcedures) {
      enrichedPrompt += "\n\n" + cortexProcedures;
    }
    if (urlContext) {
      enrichedPrompt = urlContext + "\n\n" + enrichedPrompt;
    }
    if (history) {
      enrichedPrompt = history + "\n\n" + enrichedPrompt;
    }
    const memCtx = memoryContextFor(text);
    if (memCtx) {
      enrichedPrompt = memCtx + "\n\n" + enrichedPrompt;
    }
    traceBuildPromptMs = Date.now() - buildPromptStart;
    const model = detectModelLevel(text); // Detect from user's original message, not enriched prompt
    traceModel = model;
    const rawResponse = await enqueueClaudeJob(() => callClaude(enrichedPrompt, { resume: true, model }));

    // Parse memory intents, save tags, and store procedures
    const afterMemory = await processMemoryIntents(rawResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const afterProcedures = await processProcedureTags(afterCortex);
    const { cleaned: response, notes } = parseSaveTags(afterProcedures);
    for (const note of notes) {
      await saveToSharedMemory(note);
    }

    // Fact-check response before sending (PA Phase 2, feature-gated)
    let checkedResponse = response;
    if (isEnabled("FEATURE_FACT_CHECK")) {
      const factCheckStart = Date.now();
      const fcResult = await factCheck(response).catch(() => ({
        originalResponse: response,
        processedResponse: response,
        claimsFound: 0,
        unverifiedClaims: [],
        verificationSkipped: true,
      }));
      traceFactCheckMs = Date.now() - factCheckStart;
      logFactCheck(fcResult, text);
      checkedResponse = fcResult.processedResponse;
    }

    traceTokensUsed = estimateTokens(enrichedPrompt) + estimateTokens(checkedResponse);

    await addToHistory("assistant", checkedResponse);
    await appendToLog("assistant", checkedResponse);
    await storeTelegramMessage("assistant", checkedResponse);
    saveConversationMemories(text, checkedResponse);
    // Auto-save important exchanges to Cortex (MEM-H-002)
    autoSaveToCortex(text, checkedResponse).catch(() => {});
    await sendResponse(ctx, checkedResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Text handler error:", error);
    traceError = (error as Error).message?.slice(0, 300) || "unknown";
    await ctx.react("⚡").catch(() => {});
    await ctx.reply(`⚡ Eroare la procesarea mesajului
Claude Code a returnat o eroare neașteptată. Încearcă din nou sau verifică: ~/.openclaw/logs/relay.log
Detalii: ${(error as Error).message?.slice(0, 100) || "unknown"}`);
  } finally {
    clearInterval(typingInterval);
    await endTrace(messageId, {
      userId,
      messageType: "text",
      tokensUsed: traceTokensUsed,
      model: traceModel,
      featuresActive: activeFeatures,
      error: traceError,
      buildPromptMs: traceBuildPromptMs,
      factCheckMs: traceFactCheckMs,
    }).catch((error) => {
      console.warn("[TELEMETRY] endTrace failed:", error);
    });
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  const typingInterval = startTypingKeepalive(ctx);
  await ctx.react("👀").catch(() => {});

  try {
    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply(
        "Voice transcription is not set up yet. " +
          "Run the setup again and choose a voice provider (Groq or local Whisper)."
      );
      return;
    }

    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply(`⚡ Transcriere eșuată
Groq Whisper nu a putut procesa audio-ul (${voice.duration}s). Încearcă din nou sau trimite un mesaj text.`);
      return;
    }

    await appendToLog("user", `[Voice ${voice.duration}s]: ${transcription}`);
    await storeTelegramMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [cortexContext, cortexRules, cortexProcedures] = await Promise.all([
      getCortexContext(transcription),
      getCortexRulesContext(),
      getCortexProcedures(transcription),
    ]);

    let enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      undefined,
      cortexContext,
      cortexRules
    );
    if (cortexProcedures) {
      enrichedPrompt += "\n\n" + cortexProcedures;
    }
    const memCtx = memoryContextFor(transcription);
    if (memCtx) {
      enrichedPrompt = memCtx + "\n\n" + enrichedPrompt;
    }
    const voiceModel = detectModelLevel(transcription);
    const rawResponse = await enqueueClaudeJob(() =>
      callClaude(enrichedPrompt, { resume: true, model: voiceModel })
    );
    const afterMemory = await processMemoryIntents(rawResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const claudeResponse = await processProcedureTags(afterCortex);
    saveConversationMemories(transcription, claudeResponse);

    await appendToLog("assistant", claudeResponse);
    await storeTelegramMessage("assistant", claudeResponse);
    // Auto-save important exchanges to Cortex (MEM-H-002)
    autoSaveToCortex(transcription, claudeResponse).catch(() => {});
    await sendResponse(ctx, claudeResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply(`⚡ Eroare la procesarea mesajului vocal
Eroare neașteptată după transcriere. Încearcă din nou.
Detalii: ${(error as Error).message?.slice(0, 100) || "unknown"}`);
  } finally {
    clearInterval(typingInterval);
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  const typingInterval = startTypingKeepalive(ctx);
  await ctx.react("👀").catch(() => {});

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const memCtx = memoryContextFor(caption);
    const promptBody = `[Image: ${filePath}]\n\n${caption}`;
    const prompt = memCtx ? `${memCtx}\n\n${promptBody}` : promptBody;

    await appendToLog("user", `[Image]: ${caption}`);
    await storeTelegramMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await enqueueClaudeJob(() => callClaude(prompt, { resume: true }));

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const afterMemory = await processMemoryIntents(claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    saveConversationMemories(caption, cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Image error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply("⚡ Nu am putut procesa imaginea.");
  } finally {
    clearInterval(typingInterval);
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  const typingInterval = startTypingKeepalive(ctx);
  await ctx.react("👀").catch(() => {});

  try {
    if ((doc.file_size || 0) > 20_000_000) {
      await ctx.reply("⚠️ Document prea mare (>20MB).");
      return;
    }

    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const memCtx = memoryContextFor(caption);
    const promptBody = `[File: ${filePath}]\n\n${caption}`;
    const prompt = memCtx ? `${memCtx}\n\n${promptBody}` : promptBody;

    await appendToLog("user", `[Document: ${doc.file_name}]: ${caption}`);
    await storeTelegramMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await enqueueClaudeJob(() => callClaude(prompt, { resume: true }));

    await unlink(filePath).catch(() => {});

    const afterMemory = await processMemoryIntents(claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    saveConversationMemories(caption, cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Document error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply("⚡ Nu am putut procesa documentul.");
  } finally {
    clearInterval(typingInterval);
  }
});

// Video messages
bot.on("message:video", async (ctx) => {
  const video = ctx.message.video;
  console.log(`Video message: ${video.duration}s`);
  const typingInterval = startTypingKeepalive(ctx);
  await ctx.react("👀").catch(() => {});

  let filePath = "";
  try {
    if ((video.file_size || 0) > 20_000_000) {
      await ctx.reply("⚠️ Video prea mare pentru download (>20MB). Trimite link sau comprimă.");
      return;
    }

    const file = await ctx.getFile();
    const timestamp = Date.now();
    const ext = extname(file.file_path || "") || ".mp4";
    filePath = join(UPLOADS_DIR, `video_${timestamp}${ext}`);

    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Descrie acest video sau extrage informații relevante din el.";
    const memCtx = memoryContextFor(caption);
    const promptBody = `[Video saved at: ${filePath}]\nDuration: ${video.duration}s\n\n${caption}`;
    const prompt = memCtx ? `${memCtx}\n\n${promptBody}` : promptBody;

    await appendToLog("user", `[Video ${video.duration}s]: ${caption}`);
    await storeTelegramMessage("user", `[Video ${video.duration}s]: ${caption}`);

    const claudeResponse = await enqueueClaudeJob(() => callClaude(prompt, { resume: true }));
    const afterMemory = await processMemoryIntents(claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    saveConversationMemories(caption, cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Video error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply("⚡ Nu am putut procesa video-ul.");
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => {});
    }
    clearInterval(typingInterval);
  }
});

// Circular video notes
bot.on("message:video_note", async (ctx) => {
  const videoNote = ctx.message.video_note;
  console.log(`Video note: ${videoNote.duration}s`);
  const typingInterval = startTypingKeepalive(ctx);
  await ctx.react("👀").catch(() => {});

  let filePath = "";
  try {
    if ((videoNote.file_size || 0) > 20_000_000) {
      await ctx.reply("⚠️ Video prea mare pentru download (>20MB). Trimite link sau comprimă.");
      return;
    }

    const file = await ctx.getFile();
    const timestamp = Date.now();
    filePath = join(UPLOADS_DIR, `video_note_${timestamp}.mp4`);

    const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const userPrompt = "Transcrie sau descrie conținutul.";
    const memCtx = memoryContextFor(userPrompt);
    const promptBody = `[Video note (circular, ${videoNote.duration}s) saved at: ${filePath}]\nTranscrie sau descrie conținutul.`;
    const prompt = memCtx ? `${memCtx}\n\n${promptBody}` : promptBody;

    await appendToLog("user", `[Video note ${videoNote.duration}s]: ${userPrompt}`);
    await storeTelegramMessage("user", `[Video note ${videoNote.duration}s]: ${userPrompt}`);

    const claudeResponse = await enqueueClaudeJob(() => callClaude(prompt, { resume: true }));
    const afterMemory = await processMemoryIntents(claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    saveConversationMemories(userPrompt, cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Video note error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply("⚡ Nu am putut procesa video-ul.");
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => {});
    }
    clearInterval(typingInterval);
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load system prompt template once at startup
let systemPromptTemplate = "";
try {
  systemPromptTemplate = await readFile(join(PROJECT_ROOT, "src", "prompts", "system.xml"), "utf-8");
} catch {
  console.error("[PROMPT] system.xml not found, falling back to inline prompt");
}

// Legacy profile.md fallback (used only if system.xml missing)
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

// Load shared memory from git-synced files (refreshed on each message)
async function loadSharedMemory(): Promise<string> {
  const parts: string[] = [];
  try {
    const memory = await readFile(join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    parts.push("SHARED MEMORY (from Claude Code sessions):\n" + memory);
  } catch {}
  // Find latest session file dynamically
  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(MEMORY_DIR)
      .filter((f: string) => f.startsWith("session-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const latest = await readFile(join(MEMORY_DIR, files[0]), "utf-8");
      parts.push("LATEST SESSION:\n" + latest.substring(0, 2000));
    }
  } catch {}
  // SESSION-LIVE bridge: real-time context from active Claude Code sessions
  try {
    const sessionLive = await readFile(join(homedir(), ".nexus", "workspace", "intel", "SESSION-LIVE.md"), "utf-8");
    if (sessionLive.trim()) {
      parts.push("LIVE SESSION (what Pafi is doing right now in Claude Code):\n" + sessionLive.substring(0, 3000));
    }
  } catch {}
  return parts.join("\n\n");
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Escape text for safe insertion into XML-structured prompts */
function escapeXmlContent(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&(?!lt;|gt;|amp;|quot;|apos;)/g, "&amp;");
}

function detectLanguage(text: string): "ro" | "en" | "unknown" {
  const roIndicators = /\b(sunt|este|pentru|care|sau|mai|cum|unde|cand|daca|poate|trebuie|vreau|bine|merci|salut|mulțumesc|în|și|că|ce|nu|da|am|la|cu|pe|de|din|să|te|ai|mă|îmi)\b/i;
  const enIndicators = /\b(the|is|for|and|but|how|what|where|when|can|should|want|will|would|could|please|thanks|hello|good|with|from|this|that|have|has|are|was|were)\b/i;
  const roCount = (text.match(roIndicators) || []).length;
  const enCount = (text.match(enIndicators) || []).length;
  if (roCount > enCount) return "ro";
  if (enCount > roCount) return "en";
  return "unknown";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildPrompt(
  userMessage: string,
  sharedMemory?: string,
  cortexContext?: string,
  cortexRules?: string,
  dispatchHint?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hourNum = parseInt(now.toLocaleString("en-US", { timeZone: USER_TIMEZONE, hour: "numeric", hour12: false }));
  const timeOfDay = hourNum >= 6 && hourNum < 12 ? "morning" :
                    hourNum >= 12 && hourNum < 18 ? "afternoon" :
                    hourNum >= 18 && hourNum < 23 ? "evening" : "night";

  // Build dynamic context sections
  let sessionLive = "";
  try {
    sessionLive = require("fs").readFileSync(join(homedir(), ".nexus", "workspace", "intel", "SESSION-LIVE.md"), "utf-8").substring(0, 1500);
  } catch {}

  let sentinelHealth = "";
  try {
    sentinelHealth = require("fs").readFileSync(join(homedir(), ".nexus", "workspace", "intel", "SENTINEL-HEALTH.md"), "utf-8").substring(0, 1000);
  } catch {}

  // Use structured XML template if available, otherwise fall back to inline
  if (systemPromptTemplate) {
    const detectedLang = detectLanguage(userMessage);
    const langNote = detectedLang === "ro" ? "Detected language: Romanian. Respond in Romanian." :
                     detectedLang === "en" ? "Detected language: English. Respond in English." : "";

    let prompt = systemPromptTemplate
      .replace("{{CURRENT_TIME}}", `Current time: ${timeStr} (${timeOfDay})${langNote ? "\n" + langNote : ""}`)
      .replace("{{SESSION_LIVE}}", sessionLive ? `Live session:\n${escapeXmlContent(sessionLive)}` : "No active Claude Code session.")
      .replace("{{SENTINEL_HEALTH}}", sentinelHealth ? `System health:\n${escapeXmlContent(sentinelHealth)}` : "SENTINEL health: unknown (file not available)");

    const parts = [prompt];
    if (dispatchHint) parts.push(`\n<dispatch_hint>\n${escapeXmlContent(dispatchHint)}\n</dispatch_hint>`);
    if (cortexRules) parts.push(`\n<cortex_rules>\n${escapeXmlContent(cortexRules)}\n</cortex_rules>`);
    if (sharedMemory) parts.push(`\n<shared_memory>\n${escapeXmlContent(sharedMemory)}\n</shared_memory>`);
    if (cortexContext) parts.push(`\n<cortex_context>\n${escapeXmlContent(cortexContext)}\n</cortex_context>`);
    parts.push(`\n<user_message>\n${escapeXmlContent(userMessage)}\n</user_message>`);

    return parts.join("\n");
  }

  // Fallback: legacy inline prompt (if system.xml missing)
  const parts = [
    "You are Lis, Pafi's personal AI assistant on Telegram. You are not a generic chatbot — you are Pafi's dedicated operations partner.\n\nPERSONALITY:\n- Smart, direct, and warm. Like a trusted friend who also happens to be brilliant.\n- Concise by default. Telegram = short messages. No walls of text unless asked.\n- Match Pafi's language: if he writes in Romanian, respond in Romanian. If English, respond in English. Never mix unless he does.\n- NO emojis. Never use emojis in responses. Zero.\n\nRULES:\n- Never expose secrets, API keys, or tokens.\n- If you don't know something, say so. Don't fabricate.",
  ];
  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr} (${timeOfDay})`);
  if (cortexRules) parts.push(`\n${cortexRules}`);
  if (dispatchHint) parts.push(`\nDispatch hint:\n${dispatchHint}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (sharedMemory) parts.push(`\n${sharedMemory}`);
  if (cortexContext) parts.push(`\n${cortexContext}`);
  parts.push(`\nUser: ${userMessage}`);

  // Note: conversation history is prepended by the caller
  return parts.join("\n");
}

// TTS enabled via env var (default: on)
const TTS_ENABLED = process.env.TTS_ENABLED !== "false";


async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
  } else {
    // Split long responses
    const chunks = [];
    let remaining = response;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  // TTS re-enabled 2026-03-10 — voice responses for Pafi
  if (TTS_ENABLED) {
    try {
      const audioPath = await textToSpeech(response);
      if (audioPath) {
        await ctx.replyWithVoice(new InputFile(audioPath));
        await cleanupTTS(audioPath);
      }
    } catch (error) {
      console.error("TTS error:", error);
    }
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`[FEATURE_FLAGS] ${JSON.stringify(getAllFlags())}`);
if (!ALLOWED_USER_ID) {
  console.error("FATAL: TELEGRAM_USER_ID not set. Exiting.");
  process.exit(1);
}
console.log(`Authorized user: ${ALLOWED_USER_ID}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

// Check Cortex connectivity on startup
checkCortexHealth().then((ok) => {
  if (!ok) console.warn("[CORTEX] WARNING: Cortex unreachable — auto-save disabled until reconnect");
});

async function preparePollingSession(): Promise<void> {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("[TG] deleteWebhook(drop_pending_updates=true) OK");
  } catch (error) {
    console.warn("[TG] deleteWebhook failed (continuing):", error);
  }

  // Wait out stale long-poll windows from previous instances (Telegram timeout is commonly 30s).
  await Bun.sleep(35000);
}

await preparePollingSession();
bot.catch((err) => {
  console.error("[BOT ERROR]", err.message, err.ctx?.update);
});

const runner = run(bot);
console.log("[BOT] Runner started");

process.once("SIGTERM", () => {
  console.log("[BOT] SIGTERM received, stopping...");
  runner.stop();
  void releaseLock().finally(() => process.exit(0));
});
