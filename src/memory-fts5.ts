import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const DEFAULT_RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const DEFAULT_DB_PATH = process.env.MEMORY_DB_PATH || join(DEFAULT_RELAY_DIR, "memory.db");
const PRUNE_THRESHOLD = 0.1;
const SEMANTIC_HALF_LIFE_DAYS = 110;
const EPISODIC_HALF_LIFE_DAYS = 7;
const MAX_MEMORIES = 5000;

export const SEMANTIC_TRIGGER_RE =
  /(?:^|[^\p{L}])(prefer|always|never|remember|I am|I'm|my name|I like|I don't|I do|I want|I need)(?:$|[^\p{L}])|(?:^|[^\p{L}])(prefer|mereu|niciodată|îmi place|nu îmi|ține minte|țin minte|eu sunt|vreau să|am nevoie|nu vreau|îmi trebuie|obișnuiesc)(?:$|[^\p{L}])/iu;

export interface MemoryDBContext {
  db: Database;
  sessionId: string;
}

export function computeSalience(salience: number, halfLifeDays: number, createdAt: number): number {
  const daysElapsed = (Date.now() / 1000 - createdAt) / 86400;
  return salience * Math.exp((-daysElapsed * Math.LN2) / Math.max(halfLifeDays, 0.01));
}

export function initMemoryDB(dbPath = DEFAULT_DB_PATH): MemoryDBContext {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      half_life_days REAL NOT NULL DEFAULT 110,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      access_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_message_at INTEGER NOT NULL DEFAULT (unixepoch()),
      message_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  const sessionId = Date.now().toString();
  db.query(
    `INSERT OR IGNORE INTO sessions (id, started_at, last_message_at, message_count)
     VALUES (?1, unixepoch(), unixepoch(), 0)`
  ).run(sessionId);

  return { db, sessionId };
}

export function updateSession(db: Database, sessionId: string): void {
  db.query(
    `UPDATE sessions
     SET last_message_at = unixepoch(),
         message_count = message_count + 1
     WHERE id = ?1`
  ).run(sessionId);
}

export function reinforceSalience(db: Database, memoryId: number): void {
  const row = db
    .query("SELECT salience, half_life_days FROM memories WHERE id = ?1")
    .get(memoryId) as { salience: number; half_life_days: number } | null;
  if (!row) return;

  const nextSalience = Math.min(5.0, Number(row.salience || 0) + 0.1);
  const nextHalfLife = Math.max(0.5, Number(row.half_life_days || EPISODIC_HALF_LIFE_DAYS) * 1.15);

  db.query(
    `UPDATE memories
     SET salience = ?1,
         half_life_days = ?2,
         last_accessed_at = unixepoch(),
         access_count = access_count + 1
     WHERE id = ?3`
  ).run(nextSalience, nextHalfLife, memoryId);
}

export function pruneExpired(db: Database): number {
  const rows = db
    .query(
      `SELECT id, salience, half_life_days,
              (unixepoch('now') - created_at) / 86400.0 AS days_old
       FROM memories`
    )
    .all() as Array<{ id: number; salience: number; half_life_days: number; days_old: number }>;

  const expiredIds = rows
    .filter((m) => {
      const days = Number(m.days_old || 0);
      const current =
        Number(m.salience || 0) *
        Math.exp((-days * Math.LN2) / Math.max(Number(m.half_life_days || 1), 0.01));
      return current < PRUNE_THRESHOLD;
    })
    .map((m) => m.id);

  let removed = 0;
  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => "?").join(",");
    db.query(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...expiredIds);
    removed += expiredIds.length;
  }

  const totalRow = db.query("SELECT COUNT(*) AS n FROM memories").get() as { n: number } | null;
  const total = Number(totalRow?.n || 0);
  if (total > MAX_MEMORIES) {
    const excess = total - MAX_MEMORIES;
    db.query(
      `DELETE FROM memories
       WHERE id IN (
         SELECT id FROM memories
         ORDER BY created_at ASC
         LIMIT ?1
       )`
    ).run(excess);
    removed += excess;
  }

  return removed;
}

function tokenizeForFts(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2)
    .slice(0, 8)
    .join(" OR ");
}

export function getMemoryContext(db: Database, userMessage: string): string {
  const q = tokenizeForFts(userMessage);
  const relevant = q
    ? (db
        .query(
          `SELECT rowid AS id, text
           FROM memories_fts
           WHERE memories_fts MATCH ?1
           ORDER BY rank
           LIMIT 3`
        )
        .all(q) as Array<{ id: number; text: string }>)
    : [];

  const recent = db
    .query(
      `SELECT id, text
       FROM memories
       WHERE salience > ?1
       ORDER BY last_accessed_at DESC
       LIMIT 5`
    )
    .all(PRUNE_THRESHOLD) as Array<{ id: number; text: string }>;

  const merged: Array<{ id: number; text: string }> = [];
  const seen = new Set<number>();
  for (const row of [...relevant, ...recent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }

  if (merged.length === 0) return "";

  for (const row of merged) {
    reinforceSalience(db, row.id);
  }

  const lines = merged.slice(0, 8).map((row) => `• ${row.text.replace(/\s+/g, " ").trim()}`);
  return `[Memory context]\n${lines.join("\n")}\n---`;
}

function saveMemory(db: Database, text: string, type: "semantic" | "episodic"): void {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  const halfLife = type === "semantic" ? SEMANTIC_HALF_LIFE_DAYS : EPISODIC_HALF_LIFE_DAYS;
  db.query(
    `INSERT INTO memories (text, type, salience, half_life_days, created_at, last_accessed_at, access_count)
     VALUES (?1, ?2, 1.0, ?3, unixepoch(), unixepoch(), 0)`
  ).run(cleaned.slice(0, 800), type, halfLife);
}

function pickSemanticSentence(userMessage: string): string | null {
  const normalized = userMessage.replace(/\s+/g, " ").trim();
  if (!normalized || !SEMANTIC_TRIGGER_RE.test(normalized)) return null;
  const first = normalized.split(/[.!?]/).map((s) => s.trim()).find(Boolean);
  return first ? first.slice(0, 300) : normalized.slice(0, 300);
}

export function extractAndSaveMemories(
  db: Database,
  userMessage: string,
  assistantResponse: string,
  messageCount?: number,
  sessionId?: string
): void {
  if (sessionId) {
    updateSession(db, sessionId);
  }

  const semantic = pickSemanticSentence(userMessage);
  if (semantic) {
    saveMemory(db, semantic, "semantic");
  }

  const episodic = `User: ${userMessage.slice(0, 220)} | Assistant: ${assistantResponse.slice(0, 220)}`;
  saveMemory(db, episodic, "episodic");

  if (typeof messageCount === "number" && messageCount > 0 && messageCount % 100 === 0) {
    pruneExpired(db);
  }
}

export function runMaintenance(dbPath = DEFAULT_DB_PATH): { pruned: number; total: number; dbPath: string } {
  const { db } = initMemoryDB(dbPath);
  const pruned = pruneExpired(db);
  db.exec("VACUUM;");
  const row = db.query("SELECT COUNT(*) AS total FROM memories").get() as { total: number } | null;
  const total = Number(row?.total || 0);
  db.close();
  return { pruned, total, dbPath };
}

function logMaintenance(message: string): void {
  mkdirSync(DEFAULT_RELAY_DIR, { recursive: true });
  appendFileSync(join(DEFAULT_RELAY_DIR, "memory-maintenance.log"), `${new Date().toISOString()} ${message}\n`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--maintenance")) {
    const stats = runMaintenance();
    const msg = `[MEMORY] maintenance db=${stats.dbPath} pruned=${stats.pruned} total=${stats.total}`;
    console.log(msg);
    logMaintenance(msg);
  } else {
    console.log("Usage: bun run src/memory-fts5.ts --maintenance");
  }
}
