/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { extractUrlContent, formatExtractedContent } from "./url-handler.ts";
import { saveToSharedMemory, parseSaveTags } from "./memory-sync.ts";
import { appendToLog } from "./file-logger.ts";
import {
  processCortexMemoryIntents,
  getCortexContext,
  getCortexRulesContext,
  storeTelegramMessage,
  getCortexProcedures,
  processProcedureTags,
} from "./cortex-client.ts";
import { verifyTOTP, isTOTPConfigured, generateTOTPSetup, isHardRule } from "./totp.ts";
import { textToSpeech, cleanupTTS } from "./tts.ts";
import { createReadStream } from "fs";
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

// Directories
const MEMORY_DIR = join(process.env.HOME || "~", ".claude/projects/-Users-pafi/memory");
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

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
process.on("SIGTERM", async () => {
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

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

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
// MESSAGE HANDLERS
// ============================================================

// /totp_setup command - generate new TOTP secret (admin only)
bot.command("totp_setup", async (ctx) => {
  if (isTOTPConfigured()) {
    await ctx.reply("TOTP deja configurat. Șterge TOTP_SECRET din .env pentru a regenera.");
    return;
  }
  const setup = generateTOTPSetup();
  await ctx.reply(setup.qrText);
});

// /rules command - list rules
bot.command("rules", async (ctx) => {
  const arg = ctx.match?.trim();
  if (arg === "hard" || arg === "standard" || arg === "soft" || arg === "temporary") {
    const response = await callClaude(`List all ${arg.toUpperCase()} rules from Cortex. Format: rule_id - description`, { model: "haiku" });
    await sendResponse(ctx, response);
  } else {
    await ctx.reply(
      "Comenzi reguli:\n" +
      "/rules hard - Reguli HARD (necesită TOTP)\n" +
      "/rules standard - Reguli STANDARD\n" +
      "/rules soft - Reguli SOFT\n" +
      "/rules temporary - Reguli temporare\n" +
      "/rule_modify RULE_ID - Modifică o regulă"
    );
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
    await ctx.reply(`Regula ${ruleId} este HARD. Introdu codul TOTP din Google Authenticator (ai 90 secunde):`);
    return;
  }

  // Non-HARD rules: proceed directly
  await ctx.reply(`Descrie modificarea pentru ${ruleId}:`);
});

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

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

  await saveMessage("user", text);
  await addToHistory("user", text);
  await appendToLog("user", text);
  await storeTelegramMessage("user", text);

  // Gather context: semantic search + facts/goals + conversation history + URLs + Cortex + procedures
  const [relevantContext, memoryContext, sharedMemory, urlContents, cortexContext, cortexRules, cortexProcedures] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
    loadSharedMemory(),
    extractUrlContent(text),
    getCortexContext(text),
    getCortexRulesContext(),
    getCortexProcedures(text),
  ]);

  const history = formatHistory();
  const urlContext = formatExtractedContent(urlContents);
  let enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, sharedMemory, cortexContext, cortexRules);
  if (cortexProcedures) {
    enrichedPrompt += "\n\n" + cortexProcedures;
  }
  if (urlContext) {
    enrichedPrompt = urlContext + "\n\n" + enrichedPrompt;
  }
  if (history) {
    enrichedPrompt = history + "\n\n" + enrichedPrompt;
  }
  const model = detectModelLevel(text); // Detect from user's original message, not enriched prompt
  const rawResponse = await callClaude(enrichedPrompt, { resume: true, model });

  // Parse memory intents, save tags, and store procedures
  const afterMemory = await processMemoryIntents(supabase, rawResponse);
  const afterCortex = await processCortexMemoryIntents(afterMemory);
  const afterProcedures = await processProcedureTags(afterCortex);
  const { cleaned: response, notes } = parseSaveTags(afterProcedures);
  for (const note of notes) {
    await saveToSharedMemory(note);
  }

  await addToHistory("assistant", response);
  await saveMessage("assistant", response);
  await appendToLog("assistant", response);
  await storeTelegramMessage("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);
    await appendToLog("user", `[Voice ${voice.duration}s]: ${transcription}`);
    await storeTelegramMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext, cortexContext, cortexRules, cortexProcedures] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
      getCortexContext(transcription),
      getCortexRulesContext(),
      getCortexProcedures(transcription),
    ]);

    let enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext,
      undefined,
      cortexContext,
      cortexRules
    );
    if (cortexProcedures) {
      enrichedPrompt += "\n\n" + cortexProcedures;
    }
    const voiceModel = detectModelLevel(transcription);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true, model: voiceModel });
    const afterMemory = await processMemoryIntents(supabase, rawResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const claudeResponse = await processProcedureTags(afterCortex);

    await saveMessage("assistant", claudeResponse);
    await appendToLog("assistant", claudeResponse);
    await storeTelegramMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

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
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);
    await appendToLog("user", `[Image]: ${caption}`);
    await storeTelegramMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const afterMemory = await processMemoryIntents(supabase, claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    await saveMessage("assistant", cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
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
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);
    await appendToLog("user", `[Document: ${doc.file_name}]: ${caption}`);
    await storeTelegramMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const afterMemory = await processMemoryIntents(supabase, claudeResponse);
    const afterCortex = await processCortexMemoryIntents(afterMemory);
    const cleanResponse = await processProcedureTags(afterCortex);
    await saveMessage("assistant", cleanResponse);
    await appendToLog("assistant", cleanResponse);
    await storeTelegramMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
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
  try {
    const session = await readFile(join(MEMORY_DIR, "session-2026-02-13-decisions.md"), "utf-8");
    // Only include first 2000 chars to keep prompt reasonable
    parts.push("LATEST SESSION DECISIONS:\n" + session.substring(0, 2000));
  } catch {}
  return parts.join("\n\n");
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
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

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (cortexRules) parts.push(`\n${cortexRules}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (sharedMemory) parts.push(`\n${sharedMemory}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);
  if (cortexContext) parts.push(`\n${cortexContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]" +
      "\n[SAVE: important note to sync across all devices]" +
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

  // Send voice version (non-blocking, after text)
  if (TTS_ENABLED) {
    try {
      const audioPath = await textToSpeech(response);
      if (audioPath) {
        await ctx.replyWithVoice(new InputFile(audioPath));
        await cleanupTTS(audioPath);
      }
    } catch (error) {
      console.error("TTS send error:", error);
      // Silently fail - text was already sent
    }
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
