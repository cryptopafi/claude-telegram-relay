import { mkdirSync } from "fs";
import { dirname } from "path";
import { Database } from "bun:sqlite";

export type MemoryDB = Database;

export interface MemoryContext {
  db: MemoryDB;
  sessionId: string;
  ready: boolean;
}

type MemoryRow = {
  id: number;
  text: string;
  topic: string | null;
};

const REMEMBER_TAG_RE = /\[REMEMBER:\s*([^\]]+)\]/gi;
export const SEMANTIC_TRIGGER_RE = /\b(?:remember|memorize|retine|reține|tine minte|ține minte)\b/i;

function clampText(text: string, max = 800): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function deriveTopic(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !["the", "and", "for", "with", "that", "this", "are", "you"].includes(token));
  return tokens.slice(0, 3).join(" ") || "general";
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 1.0,
      half_life_days REAL NOT NULL DEFAULT 30,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      access_count INTEGER NOT NULL DEFAULT 0,
      topic TEXT,
      entity TEXT,
      session_id TEXT,
      consolidated_from TEXT,
      consolidated_at INTEGER,
      consolidated_into INTEGER
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_type_created ON memories(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_topic_type ON memories(topic, type);
    CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(type, consolidated_at);
  `);
}

export function initMemoryDB(path: string, options?: { skipSession?: boolean }): MemoryContext {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  ensureSchema(db);

  const sessionId = options?.skipSession ? "session-skip" : `session-${Date.now()}`;
  return { db, sessionId, ready: true };
}

export function getMemoryContext(db: MemoryDB, query: string): string {
  const q = clampText(query, 300).toLowerCase();
  if (!q) return "";

  const words = q.split(/\s+/).filter((word) => word.length >= 3);
  const likeNeedle = `%${words[0] || q}%`;
  const rows = db
    .query(
      `SELECT id, text, topic
       FROM memories
       WHERE type = 'semantic'
         AND (text LIKE ?1 OR topic LIKE ?1)
       ORDER BY salience DESC, created_at DESC
       LIMIT 5`
    )
    .all(likeNeedle) as MemoryRow[];

  if (rows.length === 0) return "";

  const touchStmt = db.query(
    `UPDATE memories
     SET access_count = access_count + 1,
         last_accessed_at = unixepoch()
     WHERE id = ?1`
  );
  for (const row of rows) {
    touchStmt.run(row.id);
  }

  const lines = rows.map((row) => `- ${row.text}`);
  return `[MEMORY]\n${lines.join("\n")}`;
}

export function extractAndSaveMemories(
  db: MemoryDB,
  userMessage: string,
  assistantResponse: string,
  messageCount?: number,
  sessionId?: string,
  rawResponse?: string
): void {
  const safeUser = clampText(userMessage, 500);
  const safeAssistant = clampText(assistantResponse, 500);
  const topic = deriveTopic(`${safeUser} ${safeAssistant}`);
  const boundedSessionId = sessionId ? clampText(sessionId, 80) : null;

  const insertEpisodic = db.query(
    `INSERT INTO memories (
      text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic, session_id
    ) VALUES (?1, 'episodic', ?2, 7, unixepoch(), unixepoch(), 0, ?3, ?4)`
  );
  const episodicSalience = Math.min(2.0, 1.0 + ((messageCount || 1) % 5) * 0.1);
  insertEpisodic.run(`User: ${safeUser} | Assistant: ${safeAssistant}`, episodicSalience, topic, boundedSessionId);

  const semanticCandidates = new Set<string>();
  if (rawResponse) {
    for (const match of rawResponse.matchAll(REMEMBER_TAG_RE)) {
      const value = clampText(match[1] || "", 500);
      if (value) semanticCandidates.add(value);
    }
  }
  if (semanticCandidates.size === 0 && SEMANTIC_TRIGGER_RE.test(safeUser)) {
    const fallback = clampText(safeAssistant || safeUser, 500);
    if (fallback) semanticCandidates.add(fallback);
  }

  if (semanticCandidates.size === 0) return;

  const insertSemantic = db.query(
    `INSERT INTO memories (
      text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic, session_id
    ) VALUES (?1, 'semantic', 2.0, 180, unixepoch(), unixepoch(), 0, ?2, ?3)`
  );

  for (const memoryText of semanticCandidates) {
    insertSemantic.run(memoryText, deriveTopic(memoryText), boundedSessionId);
  }
}
