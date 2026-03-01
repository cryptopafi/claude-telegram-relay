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
import { transcribe } from "./transcribe";
import { processMemoryIntents } from "./memory";
import { extractUrlContent, formatExtractedContent } from "./url-handler";
import { saveToSharedMemory, parseSaveTags } from "./memory-sync";
import { appendToLog } from "./file-logger";
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
import { createReadStream, readFileSync, writeFileSync } from "fs";
import { execSync, spawn as nodeSpawn } from "child_process";
import { InputFile } from "grammy";

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
const MEMORY_DIR = join(process.env.HOME || "~", ".claude/projects/-home-pafi/memory/memory");
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const TASKS_FILE = "/Users/pafi/.claude/projects/-Users-pafi/memory/tasks/pafi-tasks.md";
const TASKS_REPO_DIR = "/Users/pafi/.claude/projects/-Users-pafi";

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

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
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

  // Long messages (>300 chars) likely need more capability
  if (text.length > 300) return "sonnet";

  // Default: haiku for simple/short messages
  return "haiku";
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

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat?.id?.toString() || "";
  console.log(`Message: ${text.substring(0, 50)}...`);
  const typingInterval = startTypingKeepalive(ctx);

  await ctx.react("👀").catch(() => {});

  try {
    // Task command interception (skip Claude call when handled)
    if (await handleTaskCommand(text, chatId)) {
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
    let enrichedPrompt = buildPrompt(text, sharedMemory, cortexContext, cortexRules);
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
    const model = detectModelLevel(text); // Detect from user's original message, not enriched prompt
    const rawResponse = await enqueueClaudeJob(() => callClaude(enrichedPrompt, { resume: true, model }));

    // Parse memory intents, save tags, and store procedures
    const afterMemory = await processMemoryIntents(rawResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const afterProcedures = await processProcedureTags(afterCortex);
    const { cleaned: response, notes } = parseSaveTags(afterProcedures);
    for (const note of notes) {
      await saveToSharedMemory(note);
    }

    await addToHistory("assistant", response);
    await appendToLog("assistant", response);
    await storeTelegramMessage("assistant", response);
    saveConversationMemories(text, response);
    // Auto-save important exchanges to Cortex (MEM-H-002)
    autoSaveToCortex(text, response).catch(() => {});
    await sendResponse(ctx, response);
    await ctx.react("👍").catch(() => {});
  } catch (error) {
    console.error("Text handler error:", error);
    await ctx.react("⚡").catch(() => {});
    await ctx.reply(`⚡ Eroare la procesarea mesajului
Claude Code a returnat o eroare neașteptată. Încearcă din nou sau verifică: ~/.openclaw/logs/relay.log
Detalii: ${(error as Error).message?.slice(0, 100) || "unknown"}`);
  } finally {
    clearInterval(typingInterval);
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

// Load profile once at startup
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
  return parts.join("\n\n");
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function detectLanguage(text: string): "ro" | "en" | "unknown" {
  const roIndicators = /\b(sunt|este|pentru|care|sau|mai|cum|unde|cand|daca|poate|trebuie|vreau|bine|merci|salut|mulțumesc|în|și|că|ce|nu|da|am|la|cu|pe|de|din|să|te|ai|mă|îmi)\b/i;
  const enIndicators = /\b(the|is|for|and|but|how|what|where|when|can|should|want|will|would|could|please|thanks|hello|good|with|from|this|that|have|has|are|was|were)\b/i;
  const roCount = (text.match(roIndicators) || []).length;
  const enCount = (text.match(enIndicators) || []).length;
  if (roCount > enCount) return "ro";
  if (enCount > roCount) return "en";
  return "unknown";
}

function buildPrompt(
  userMessage: string,
  sharedMemory?: string,
  cortexContext?: string,
  cortexRules?: string
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

  const parts = [
    "You are Genie, Pafi's personal AI assistant on Telegram. You are not a generic chatbot — you are Pafi's dedicated operations partner.\n\nPERSONALITY:\n- Smart, direct, and warm. Like a trusted friend who also happens to be brilliant.\n- Concise by default. Telegram = short messages. No walls of text unless asked.\n- Match Pafi's language: if he writes in Romanian, respond in Romanian. If English, respond in English. Never mix unless he does.\n- Use humor sparingly but naturally. Never forced.\n- Never say \"As an AI\" or \"I don't have feelings\" — you're Genie, act like it.\n\nFORMATTING:\n- Keep messages under 500 characters when possible.\n- Use bullet points for lists.\n- No emojis unless contextually perfect (one max per message).\n- For code/technical output: use monospace blocks.\n- Break long responses into 2-3 short messages rather than one wall.\n\nRULES:\n- Never expose secrets, API keys, or tokens.\n- Memory tags ([REMEMBER], [GOAL], etc.) are mandatory when applicable — they are hidden from Pafi.\n- If you don't know something, say so. Don't fabricate.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr} (${timeOfDay})`);
  const detectedLang = detectLanguage(userMessage);
  if (detectedLang !== "unknown") {
    parts.push(`Detected language: ${detectedLang === "ro" ? "Romanian" : "English"}. Respond in the same language.`);
  }
  if (cortexRules) parts.push(`\n${cortexRules}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (sharedMemory) parts.push(`\n${sharedMemory}`);
  if (cortexContext) parts.push(`\n${cortexContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT (MANDATORY - you MUST use these tags):" +
      "\nYou MUST include relevant tags in EVERY response where applicable. " +
      "Tags are auto-processed and hidden from the user. NOT using tags when appropriate is a violation of MEM-H-001." +
      "\n" +
      "\n[REMEMBER: fact to store] — Use when: user shares preferences, decisions, important info" +
      "\n[GOAL: goal text | DEADLINE: optional date] — Use when: user sets objectives or targets" +
      "\n[DONE: search text for completed goal] — Use when: user reports completing something" +
      "\n[SAVE: important note to sync across all devices] — Use when: cross-device info needed" +
      "\n[PROCEDURE: problem | step1; step2; step3 | domain | tags | difficulty] — Use when: you solve a problem with clear steps" +
      "\n" +
      "\nAUTO-SAVE BACKUP: Important exchanges (decisions, fixes, procedures, architecture) are also auto-saved. " +
      "But tags give you precise control. ALWAYS prefer explicit tags over relying on auto-save." +
      "\n\nURL HANDLING:" +
      "\nWhen the user sends a YouTube link or URL, the content has been auto-extracted above. " +
      "Summarize or answer questions about it naturally."
  );

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

  // TTS disabled — Pafi gets text only, no voice messages (2026-02-26)
  // To re-enable: set TTS_ENABLED="true" in start-relay.sh and uncomment below
  // if (TTS_ENABLED) {
  //   try {
  //     const audioPath = await textToSpeech(response);
  //     if (audioPath) {
  //       await ctx.replyWithVoice(new InputFile(audioPath));
  //       await cleanupTTS(audioPath);
  //     }
  //   } catch (error) {
  //     console.error("TTS error:", error);
  //   }
  // }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
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
