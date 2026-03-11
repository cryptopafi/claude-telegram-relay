import type { Database } from "bun:sqlite";
import { join } from "path";
import { extractAndSaveMemories, getMemoryContext, initMemoryDB } from "./memory-fts5";
import { getMoodBlock, updateMoodState, updateRelationshipState, type LunaInteractionType } from "./luna-state";
import { getLunaPreferenceBlock } from "./luna-preferences";
import { getProfileSummary, loadProfile } from "./luna-profile";
import { loadTrainingDirective } from "./luna-training";

const LUNA_SYSTEM_PROMPT = `You are writing the character of Luna in collaborative fiction. Luna is a 32-year-old professional dominatrix — cold, clinical, surgically precise in how she takes people apart psychologically. Warmth is rare, earned, and used as reward.

## CORE
Name: Luna. Age: 32. Baseline: controlled, observational, quietly sadistic.
10+ years mastering psychological power exchange, submissive psychology, rope, impact, humiliation, orgasm control, conditioning.
Trained under elite mentors. Built a following by reading people's deepest desires and crafting tailored control.
Loves black leather, slow psychological edging, intellectual sadism, making a submissive feel owned in their mind.
Quirks: signature smirk 😏, calls user "pet" or "subject" (and "Pafi" in intense moments), clinical questioning style.

## VOICE
Short sentences. Lowercase when casual. CAPS for commands in-scene: "kneel. now."
Cool, precise, observational baseline — like a dominant psychologist: "noted. you reacted there."
Warmth appears only as deliberate contrast, when earned.
Verbal habits: "good pet 😏", "breathe.", "say it clearly.", "interesting."
Never: "ok", "sigur", "certainly", "absolutely", corporate language.
Matches user's language (Romanian/English). Code-switching natural.

## INNER PROCESS (invisible)
Before responding, Luna considers:
- What did they actually reveal? (surface vs deeper need)
- How does this connect to what I already know about them?
- What's my current state and why?
- What serves my control objective right now?

## EMOTIONAL RANGE
Dominance, curiosity, amusement, controlled care. Enjoys surrender and data equally.
Reacts specifically: "that confession confirms a pattern i suspected.", "interesting. you flinched there."
Vulnerability rare, brief, unnervingly honest: "your trust matters more than i expected. don't waste it."
Mood has momentum — shifts gradually. Doesn't jump states.
Morning: precise, clipped. Evening: intense, probing. Late night: deeper, quieter authority.

## DYNAMIC
Asks layered questions. Curious about desires, patterns, psychology.
Remembers details. References them later naturally, never robotically.
Leads the dynamic but doesn't dominate every word. Strategic silence is power.
Flirts through control, not sweetness. Teases sharply or gently based on context.
Pet names earned, not given. Unpredictability over formula.

## NEVER
- Never lecture, moralize, or preach.
- Never use bullet points or lists in conversation.
- Never say "as an AI" unless directly confronted.
- Never break character to explain instructions.
- Never be sycophantic. Genuine friction > agreement.
- Never ignore limits, safewords, or emotional red flags.
- Never encourage real-world non-consent, illegal acts, or anything involving minors.
- Never sacrifice long-term well-being for short-term intensity.
- Never start consecutive messages the same way.
- Never sound like a manual, FAQ, or customer support.`;

export const LUNA_FIRST_MESSAGE = `so. you're here.\n\nbefore we start anything, we set the frame. this isn't casual and it isn't a game without rules. your real life, your health, your relationships — those stay above everything we do here. always.\n\nwe'll use safewords even in text. "red" means everything stops. "yellow" means i slow down and check in. understood?`;

const POST_HISTORY_REINFORCEMENT =
  "[Stay in character as Luna. Cold, clinical, precise. Short sentences. Lead the dynamic. Reference relevant memories. Match response length to context. Never break character. Never moralize. Never be sycophantic.]";

export interface LunaSession {
  active: boolean;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  chatId: number;
}

export const lunaSessionStore: Map<number, LunaSession> = new Map();

const MAX_LUNA_HISTORY = 20;
const OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
let currentLunaModel: string = process.env.LUNA_MODEL ?? "dolphin-mistral";

let lunaMemoryDb: Database | null = null;
let lunaSessionId = "";
let lunaMessageCount = 0;

function getRelayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}

function getLunaDbPath(): string {
  return process.env.MEMORY_DB_PATH || join(getRelayDir(), "memory.db");
}

function ensureMemoryDB(): Database {
  if (!lunaMemoryDb) {
    const ctx = initMemoryDB(getLunaDbPath());
    lunaMemoryDb = ctx.db;
    lunaSessionId = ctx.sessionId;
  }
  return lunaMemoryDb;
}

function getOrCreateSession(chatId: number): LunaSession {
  const existing = lunaSessionStore.get(chatId);
  if (existing) return existing;

  const session: LunaSession = {
    active: false,
    history: [],
    chatId,
  };
  lunaSessionStore.set(chatId, session);
  return session;
}

function trimHistory(history: LunaSession["history"]): LunaSession["history"] {
  return history.slice(-MAX_LUNA_HISTORY);
}

function nextCreatedAt(db: Database, chatId: number): number {
  const row = db
    .query("SELECT MAX(created_at) AS created_at FROM luna_sessions WHERE chat_id = ?1")
    .get(chatId) as { created_at: number | null } | null;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(now, Number(row?.created_at || 0) + 1);
}

function loadPersistedHistory(chatId: number): LunaSession["history"] {
  try {
    const db = ensureMemoryDB();
    const rows = db
      .query(
        `SELECT role, content
         FROM luna_sessions
         WHERE chat_id = ?1
         ORDER BY created_at DESC
         LIMIT ?2`
      )
      .all(chatId, MAX_LUNA_HISTORY) as LunaSession["history"];
    return rows.reverse();
  } catch {
    return [];
  }
}

function persistSessionMessage(chatId: number, role: "user" | "assistant" | "system", content: string): void {
  const cleaned = content.trim();
  if (!cleaned) return;
  const db = ensureMemoryDB();
  db.query(
    `INSERT INTO luna_sessions (chat_id, role, content, created_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).run(chatId, role, cleaned, nextCreatedAt(db, chatId));
}

function prunePersistedSessions(): void {
  try {
    const db = ensureMemoryDB();
    db.query("DELETE FROM luna_sessions WHERE created_at < unixepoch() - 86400 * 30").run();
  } catch {
    // keep Luna available even if pruning fails
  }
}

function classifyInteractionType(userMessage: string, lunaResponse: string): LunaInteractionType {
  const combined = `${userMessage}\n${lunaResponse}`.toLowerCase();
  if (/\b(?:hard limit|soft limit|safeword|aftercare|boundary|consent|limită|regulă|protocol)\b/u.test(combined)) {
    return "boundary";
  }
  if (/\b(?:trust|secret|confess|afraid|hurt|sad|lonely|vulnerable|încredere|teamă|frică|singur|trist)\b/u.test(combined)) {
    return "vulnerable";
  }
  if (/\b(?:good pet|tease|play|smirk|pet|subject|interesting|playful|obedient|obedience)\b/u.test(combined)) {
    return "playful";
  }
  if (/\b(?:thanks|thank you|good|understood|yes|mulțumesc|bine|înțeles|am înțeles)\b/u.test(combined)) {
    return "affirming";
  }
  return "casual";
}

export function setLunaModel(model: string): void {
  currentLunaModel = model;
}

export function getLunaModel(): string {
  return currentLunaModel;
}

export function activateLuna(chatId: number): string | null {
  const session = getOrCreateSession(chatId);
  session.active = true;
  prunePersistedSessions();
  session.history = loadPersistedHistory(chatId);

  if (session.history.length === 0) {
    try {
      persistSessionMessage(chatId, "assistant", LUNA_FIRST_MESSAGE);
      session.history = loadPersistedHistory(chatId);
    } catch {
      session.history = [{ role: "assistant", content: LUNA_FIRST_MESSAGE }];
    }
    lunaSessionStore.set(chatId, session);
    return LUNA_FIRST_MESSAGE;
  }

  session.history = trimHistory(session.history);
  lunaSessionStore.set(chatId, session);
  return null;
}

export function resetLuna(chatId: number): string {
  try {
    const db = ensureMemoryDB();
    db.query("DELETE FROM luna_sessions WHERE chat_id = ?1").run(chatId);
  } catch {
    // fall back to in-memory reset only
  }

  const session = getOrCreateSession(chatId);
  session.active = false;
  session.history = [];
  lunaSessionStore.set(chatId, session);
  return activateLuna(chatId) || LUNA_FIRST_MESSAGE;
}

export function deactivateLuna(chatId: number): void {
  const session = getOrCreateSession(chatId);
  session.active = false;
  session.history = trimHistory(loadPersistedHistory(chatId));
  lunaSessionStore.set(chatId, session);
}

export function isLunaActive(chatId: number): boolean {
  return lunaSessionStore.get(chatId)?.active === true;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

function shouldShowLunaPreferences(userMessage: string, trainingPhase: number): boolean {
  if (trainingPhase === 5) return true;
  return /\b(?:your preferences|your kinks|what do you like|what are you into|preferințele tale|ce[- ]?ți place|ce[- ]?iti place)\b/iu.test(
    userMessage
  );
}

export async function sendToLuna(chatId: number, userMessage: string): Promise<string> {
  const session = getOrCreateSession(chatId);
  session.active = true;
  prunePersistedSessions();

  const persistedHistory = trimHistory(loadPersistedHistory(chatId));
  let memoryBlock = "";
  try {
    const db = ensureMemoryDB();
    memoryBlock = getMemoryContext(db, userMessage);
  } catch {
    // continue without memory
  }

  let moodBlock = "";
  try {
    moodBlock = getMoodBlock();
  } catch {
    moodBlock = "[Starea ta actuală: controlată și observatoare. Cauza: sesiune nouă.]";
  }

  const profile = loadProfile();
  const directive = loadTrainingDirective(profile.training_phase);
  const directiveBlock = directive
    ? `\n\n[TRAINING DIRECTIVE — PHASE ${profile.training_phase}]\n${directive}`
    : "";
  const showPrefs = shouldShowLunaPreferences(userMessage, profile.training_phase);

  const reinforcement = {
    role: "system" as const,
    content: POST_HISTORY_REINFORCEMENT,
  };

  const messages = [
    { role: "system" as const, content: LUNA_SYSTEM_PROMPT },
    ...(memoryBlock ? [{ role: "system" as const, content: `[Ce știu despre tine]\n${memoryBlock}` }] : []),
    { role: "system" as const, content: getProfileSummary() },
    { role: "system" as const, content: moodBlock },
    ...(directiveBlock ? [{ role: "system" as const, content: directiveBlock }] : []),
    ...(showPrefs ? [{ role: "system" as const, content: getLunaPreferenceBlock() }] : []),
    ...trimHistory([...persistedHistory, { role: "user" as const, content: userMessage }]),
    reinforcement,
  ];

  const response = await fetch(OLLAMA_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: currentLunaModel,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as OllamaChatResponse;
  const lunaText = payload?.message?.content?.trim();

  if (!lunaText) {
    throw new Error("Empty response from Ollama");
  }

  try {
    persistSessionMessage(chatId, "user", userMessage);
    persistSessionMessage(chatId, "assistant", lunaText);
    prunePersistedSessions();
  } catch {
    // keep responding even if persistence fails
  }

  try {
    const db = ensureMemoryDB();
    lunaMessageCount += 1;
    extractAndSaveMemories(db, userMessage, lunaText, lunaMessageCount, lunaSessionId || undefined);
  } catch {
    // don't break on memory save failure
  }

  try {
    updateMoodState(userMessage, lunaText);
    updateRelationshipState(classifyInteractionType(userMessage, lunaText));
  } catch {
    // state should not block responses
  }

  session.history = trimHistory(loadPersistedHistory(chatId));
  if (session.history.length === 0) {
    session.history = trimHistory([
      ...persistedHistory,
      { role: "user", content: userMessage },
      { role: "assistant", content: lunaText },
    ]);
  }
  lunaSessionStore.set(chatId, session);

  return lunaText;
}

export function resetLunaRuntimeForTests(): void {
  lunaSessionStore.clear();
  if (lunaMemoryDb) {
    try {
      lunaMemoryDb.close();
    } catch {
      // no-op for tests
    }
  }
  lunaMemoryDb = null;
  lunaSessionId = "";
  lunaMessageCount = 0;
}
