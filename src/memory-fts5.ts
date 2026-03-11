import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const DEFAULT_RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const DEFAULT_DB_PATH = process.env.MEMORY_DB_PATH || join(DEFAULT_RELAY_DIR, "memory.db");
const PRUNE_THRESHOLD = 0.1;
const SEMANTIC_HALF_LIFE_DAYS = 110;
const EPISODIC_HALF_LIFE_DAYS = 7;
const MAX_HALF_LIFE = 365;
const MAX_SALIENCE = 3.0;
const MAX_MEMORIES = 5000;

const SEMANTIC_PATTERNS = [
  String.raw`\b(?:prefer|always|never|remember|i am|i'm|my name|i like|i don't|i do|i want|i need)\b`,
  String.raw`\b(?:prefer|mereu|niciodată|îmi place|nu îmi|ține minte|țin minte|eu sunt|vreau să|am nevoie|nu vreau|îmi trebuie|obișnuiesc|folosesc|am setat|am configurat|am decis|lucr[aă]m cu|prefer[aă]|nu mai|de acum|dintotdeauna)\b`,
  String.raw`\bcontul meu\b`,
  String.raw`\bproiectul\s+[\p{L}\d_-]{2,}\b`,
  String.raw`\bechipa are\b`,
  String.raw`\bagentul\s+[\p{L}\d_-]{2,}\b`,
  String.raw`\bregula este\b`,
  String.raw`\bprocedura\s+[\p{L}\d_-]{2,}\b`,
  String.raw`\bpreferin(?:ț|t)a mea\b`,
  String.raw`\b(?:hard limit|soft limit|safeword|kink|fetish|fantasy|rating|sissy|feminization|orgasm denial|aftercare)\b`,
  String.raw`\b(?:limită|preferință|fantezi[ae]|fetiș|regulă|protocol|ritual|task|training)\b`,
];

const REMEMBER_TAG_RE = /\[REMEMBER:\s*([^\]]+?)\]/giu;

export const SEMANTIC_TRIGGER_RE = new RegExp(SEMANTIC_PATTERNS.join("|"), "iu");

const STOPWORDS = new Set(
  [
    // EN (50)
    "the",
    "is",
    "and",
    "a",
    "to",
    "in",
    "of",
    "for",
    "on",
    "at",
    "with",
    "from",
    "by",
    "it",
    "this",
    "that",
    "these",
    "those",
    "be",
    "are",
    "was",
    "were",
    "as",
    "or",
    "an",
    "if",
    "then",
    "than",
    "but",
    "not",
    "no",
    "yes",
    "do",
    "does",
    "did",
    "done",
    "have",
    "has",
    "had",
    "i",
    "you",
    "he",
    "she",
    "we",
    "they",
    "me",
    "my",
    "your",
    "our",
    "their",
    // RO (50)
    "și",
    "si",
    "este",
    "sunt",
    "am",
    "ai",
    "are",
    "avem",
    "aveti",
    "aveți",
    "au",
    "un",
    "o",
    "una",
    "unui",
    "unei",
    "de",
    "la",
    "cu",
    "pe",
    "pentru",
    "din",
    "care",
    "ce",
    "ca",
    "nu",
    "da",
    "în",
    "in",
    "prin",
    "asupra",
    "după",
    "dupa",
    "dacă",
    "daca",
    "sau",
    "ori",
    "nici",
    "doar",
    "mai",
    "foarte",
    "eu",
    "tu",
    "el",
    "ea",
    "noi",
    "voi",
    "ei",
    "ele",
    "lor",
    "meu",
  ].map((w) => w.toLowerCase())
);

const KNOWN_ENTITIES = new Map<string, RegExp>([
  ["Codex", /\bcodex\b/i],
  ["FORGE", /\bforge\b/i],
  ["SENTINEL", /\bsentinel\b/i],
  ["IRIS", /\biris\b/i],
  ["Delphi", /\bdelphi\b/i],
  ["ECHELON", /\bechelon\b/i],
  ["RADAR", /\bradar\b/i],
  ["Gmail", /\bgmail\b/i],
  ["Notion", /\bnotion\b/i],
  ["Cortex", /\bcortex\b/i],
  ["Albastru", /\balbastru\b/i],
  ["SMSads", /\bsmsads\b/i],
  ["Clickwin", /\bclickwin\b/i],
  ["OpenClaw", /\bopenclaw\b/i],
  ["Solnest", /\bsolnest\b/i],
]);

const TOPIC_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(?:pipeline|flux)\b/i, "pipeline"],
  [/\b(?:deploy|release|rollout)\b/i, "deployment"],
  [/\b(?:fix(?:ed|ing|es)?|bug|eroare|repar\w*)\b/i, "bugfix"],
  [/\b(?:audit|verific\w*)\b/i, "quality"],
  [/\b(?:triage|email|mail|inbox)\b/i, "email"],
  [/\b(?:research|cercet\w*|analiz\w*)\b/i, "research"],
  [/\b(?:schedul\w*|calendar|întâlnire|intalnire|reminder)\b/i, "calendar"],
];

const DIACRITIC_FOLD: Record<string, string> = {
  ă: "a",
  â: "a",
  î: "i",
  ș: "s",
  ş: "s",
  ț: "t",
  ţ: "t",
  Ă: "a",
  Â: "a",
  Î: "i",
  Ș: "s",
  Ş: "s",
  Ț: "t",
  Ţ: "t",
};

export interface MemoryDBContext {
  db: Database;
  sessionId: string;
}

function stripRomanianDiacritics(text: string): string {
  return text.replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (char) => DIACRITIC_FOLD[char] || char);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function createFtsArtifacts(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      content=memories,
      content_rowid=id,
      tokenize='unicode61 remove_diacritics 0'
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
  `);
}

function ensureFtsTokenizer(db: Database): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as
    | { sql: string | null }
    | null;
  const sql = (row?.sql || "").toLowerCase();
  if (!row || sql.includes("remove_diacritics 0")) {
    createFtsArtifacts(db);
    return;
  }

  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TABLE IF EXISTS memories_fts;
  `);
  createFtsArtifacts(db);
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
}

export function computeSalience(salience: number, halfLifeDays: number, createdAt: number): number {
  const daysElapsed = (Date.now() / 1000 - createdAt) / 86400;
  return salience * Math.exp((-daysElapsed * Math.LN2) / Math.max(halfLifeDays, 0.01));
}

export function initMemoryDB(dbPath = DEFAULT_DB_PATH, { skipSession = false } = {}): MemoryDBContext {
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

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_message_at INTEGER NOT NULL DEFAULT (unixepoch()),
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS luna_sessions (
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (chat_id, created_at)
    );
  `);

  const existingColumns = new Set(
    (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!existingColumns.has("topic")) {
    db.exec("ALTER TABLE memories ADD COLUMN topic TEXT DEFAULT NULL;");
  }
  if (!existingColumns.has("entity")) {
    db.exec("ALTER TABLE memories ADD COLUMN entity TEXT DEFAULT NULL;");
  }
  if (!existingColumns.has("consolidated_from")) {
    db.exec("ALTER TABLE memories ADD COLUMN consolidated_from TEXT DEFAULT NULL;");
  }
  if (!existingColumns.has("cortex_id")) {
    db.exec("ALTER TABLE memories ADD COLUMN cortex_id TEXT DEFAULT NULL;");
  }
  if (!existingColumns.has("consolidated_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN consolidated_at INTEGER DEFAULT NULL;");
  }
  if (!existingColumns.has("consolidated_into")) {
    db.exec("ALTER TABLE memories ADD COLUMN consolidated_into INTEGER DEFAULT NULL;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(entity);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_type_topic ON memories(type, topic);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_consolidated_at ON memories(consolidated_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_luna_sessions_chat_created_at ON luna_sessions(chat_id, created_at DESC);");
  ensureFtsTokenizer(db);
  db.exec("PRAGMA journal_mode=WAL;");

  let sessionId = "maintenance";
  if (!skipSession) {
    sessionId = Date.now().toString();
    db.query(
      `INSERT OR IGNORE INTO sessions (id, started_at, last_message_at, message_count)
       VALUES (?1, unixepoch(), unixepoch(), 0)`
    ).run(sessionId);
  }

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

  const nextSalience = Math.min(MAX_SALIENCE, Number(row.salience || 0) + 0.1);
  const nextHalfLife = Math.min(
    MAX_HALF_LIFE,
    Math.max(0.5, Number(row.half_life_days || EPISODIC_HALF_LIFE_DAYS) * 1.15)
  );

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
  const tokens = normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2 && !STOPWORDS.has(x))
    .slice(0, 8);
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    expanded.add(stripRomanianDiacritics(token));
  }
  return Array.from(expanded).filter(Boolean).slice(0, 12).join(" OR ");
}

function detectEntity(text: string): string | null {
  for (const [entity, re] of KNOWN_ENTITIES) {
    if (re.test(text)) return entity;
  }
  return null;
}

function detectTopic(text: string): string | null {
  const normalized = `${text}\n${stripRomanianDiacritics(text)}`;
  for (const [re, topic] of TOPIC_KEYWORDS) {
    if (re.test(normalized)) return topic;
  }
  return null;
}

export function getMemoryContext(db: Database, userMessage: string): string {
  const q = tokenizeForFts(userMessage);
  const queryTopic = detectTopic(userMessage);
  const relevant = q
    ? (db
        .query(
          `SELECT m.id AS id, m.text
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ?1
             AND (m.consolidated_at IS NULL OR m.type = 'semantic')
           ORDER BY
             CASE WHEN ?2 IS NOT NULL AND m.topic = ?2 THEN 0 ELSE 1 END ASC,
             bm25(memories_fts) ASC,
             m.salience DESC
           LIMIT 5`
        )
        .all(q, queryTopic) as Array<{ id: number; text: string }>)
    : [];

  const recent = db
    .query(
      `SELECT id, text
       FROM memories
       WHERE salience > ?1
         AND (consolidated_at IS NULL OR type = 'semantic')
       ORDER BY
         CASE WHEN ?2 IS NOT NULL AND topic = ?2 THEN 0 ELSE 1 END ASC,
         last_accessed_at DESC
       LIMIT 5`
    )
    .all(PRUNE_THRESHOLD, queryTopic) as Array<{ id: number; text: string }>;

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

function saveMemory(
  db: Database,
  text: string,
  type: "semantic" | "episodic",
  opts: { topic?: string | null; entity?: string | null; consolidatedFrom?: string | null } = {}
): void {
  const cleaned = normalizeText(text);
  if (!cleaned) return;
  const halfLife = type === "semantic" ? SEMANTIC_HALF_LIFE_DAYS : EPISODIC_HALF_LIFE_DAYS;
  const entity = opts.entity !== undefined ? opts.entity : detectEntity(cleaned);
  const topic = opts.topic !== undefined ? opts.topic : detectTopic(cleaned);
  db.query(
    `INSERT INTO memories (
      text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic, entity, consolidated_from
    ) VALUES (?1, ?2, 1.0, ?3, unixepoch(), unixepoch(), 0, ?4, ?5, ?6)`
  ).run(cleaned.slice(0, 800), type, halfLife, topic, entity, opts.consolidatedFrom ?? null);
}

function extractRememberFacts(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const match of text.matchAll(REMEMBER_TAG_RE)) {
    const fact = normalizeText(match[1] || "");
    if (fact) out.push(fact.slice(0, 300));
  }
  return out;
}

function extractSemanticSentences(text: string, maxItems = 2): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const picked: string[] = [];
  for (const sentence of splitSentences(normalized)) {
    if (!SEMANTIC_TRIGGER_RE.test(sentence)) continue;
    picked.push(sentence.slice(0, 300));
    if (picked.length >= maxItems) break;
  }
  if (picked.length === 0 && SEMANTIC_TRIGGER_RE.test(normalized)) {
    picked.push(normalized.slice(0, 300));
  }
  return picked;
}

function uniqueTrimmed(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = normalizeText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function buildEpisodicText(userMessage: string, assistantResponse: string): string {
  return `User: ${userMessage.slice(0, 220)} | Assistant: ${assistantResponse.slice(0, 220)}`;
}

export function extractAndSaveMemories(
  db: Database,
  userMessage: string,
  assistantResponse: string,
  messageCount?: number,
  sessionId?: string,
  rawAssistantResponse?: string
): void {
  if (sessionId) {
    updateSession(db, sessionId);
  }

  const semanticFacts = uniqueTrimmed([
    ...extractSemanticSentences(userMessage, 2),
    ...extractSemanticSentences(assistantResponse, 2),
    ...extractRememberFacts(rawAssistantResponse || assistantResponse),
  ]).slice(0, 6);

  for (const fact of semanticFacts) {
    saveMemory(db, fact, "semantic");
  }

  saveMemory(db, buildEpisodicText(userMessage, assistantResponse), "episodic");

  if (typeof messageCount === "number" && messageCount > 0 && messageCount % 100 === 0) {
    pruneExpired(db);
  }
}

export function runMaintenance(dbPath = DEFAULT_DB_PATH): { pruned: number; total: number; dbPath: string } {
  const { db } = initMemoryDB(dbPath, { skipSession: true });
  db.exec(
    `UPDATE memories
     SET half_life_days = MIN(half_life_days, ${MAX_HALF_LIFE})
     WHERE half_life_days > ${MAX_HALF_LIFE};`
  );
  db.exec(
    `UPDATE memories
     SET salience = MIN(salience, ${MAX_SALIENCE})
     WHERE salience > ${MAX_SALIENCE};`
  );
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
