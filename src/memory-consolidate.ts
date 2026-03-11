import { homedir } from "os";
import { join } from "path";
import { initMemoryDB } from "./memory-fts5";

const DEFAULT_DB_PATH = process.env.MEMORY_DB_PATH || join(homedir(), ".nexus", "memory", "lis-memory.db");
const DEFAULT_WINDOW_DAYS = Number(process.env.MEMORY_CONSOLIDATE_WINDOW_DAYS || "30");
const DEFAULT_MIN_GROUP_SIZE = Number(process.env.MEMORY_CONSOLIDATE_MIN_GROUP_SIZE || "2");
const MAX_SUMMARY_SALIENCE = 3.0;
const MAX_SUMMARY_HALF_LIFE_DAYS = 365;

interface EpisodicMemoryRow {
  id: number;
  text: string;
  salience: number;
  created_at: number;
  last_accessed_at: number;
  topic: string | null;
}

export interface ConsolidationResult {
  dbPath: string;
  windowDays: number;
  scannedRows: number;
  eligibleRows: number;
  groupsSeen: number;
  groupsConsolidated: number;
  summariesCreated: number;
  originalsMarked: number;
  skippedGroups: number;
  summaryIds: number[];
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "unknown";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function normalizeTopic(topic: string | null): string {
  const cleaned = normalizeText(topic || "");
  return cleaned || "general";
}

function extractFact(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const assistant = normalized.match(/\bAssistant:\s*(.+)$/i)?.[1];
  const user = normalized.match(/\bUser:\s*(.+?)\s*\|\s*Assistant:/i)?.[1];
  const preferred = assistant || user || normalized;
  return preferred.slice(0, 140);
}

function buildSummary(topic: string, rows: EpisodicMemoryRow[]): string {
  const sortedByDate = [...rows].sort((a, b) => a.created_at - b.created_at);
  const firstDate = formatDate(sortedByDate[0]?.created_at || 0);
  const lastDate = formatDate(sortedByDate[sortedByDate.length - 1]?.created_at || 0);
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;

  const keyFacts = [...rows]
    .sort((a, b) => Number(b.salience || 0) - Number(a.salience || 0))
    .map((row) => extractFact(row.text))
    .filter(Boolean);
  const topFacts = Array.from(new Set(keyFacts)).slice(0, 3);
  const factsText = topFacts.length > 0 ? topFacts.join("; ") : "n/a";

  const lastActive = formatDate(
    Math.max(
      ...rows.map((row) => Math.max(Number(row.last_accessed_at || 0), Number(row.created_at || 0))),
      0
    )
  );

  return `${topic}: ${rows.length} interactions from ${dateRange}. Key facts: ${factsText}. Last active: ${lastActive}.`;
}

function groupByTopic(rows: EpisodicMemoryRow[]): Map<string, EpisodicMemoryRow[]> {
  const groups = new Map<string, EpisodicMemoryRow[]>();
  for (const row of rows) {
    const topic = normalizeTopic(row.topic);
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic)!.push(row);
  }
  return groups;
}

function computeSummarySalience(groupSize: number): number {
  const base = 1 + Math.log10(Math.max(groupSize, 1));
  return Math.min(MAX_SUMMARY_SALIENCE, Math.max(1, base));
}

function computeSummaryHalfLife(groupSize: number): number {
  const scaled = 120 + groupSize * 5;
  return Math.min(MAX_SUMMARY_HALF_LIFE_DAYS, Math.max(90, scaled));
}

interface ConsolidateOptions {
  dbPath?: string;
  nowEpoch?: number;
  windowDays?: number;
  minGroupSize?: number;
}

export async function consolidateMemories(options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const nowEpoch = Number(options.nowEpoch || Math.floor(Date.now() / 1000));
  const windowDays = Math.max(1, Number(options.windowDays || DEFAULT_WINDOW_DAYS));
  const minGroupSize = Math.max(1, Number(options.minGroupSize || DEFAULT_MIN_GROUP_SIZE));
  const windowStart = nowEpoch - windowDays * 86400;

  const { db } = initMemoryDB(dbPath, { skipSession: true });

  const scannedRows =
    Number((db.query("SELECT COUNT(*) AS n FROM memories WHERE type = 'episodic' AND consolidated_at IS NULL").get() as
      | { n: number }
      | null)?.n) || 0;

  const eligibleRows = (db
    .query(
      `SELECT id, text, salience, created_at, last_accessed_at, topic
       FROM memories
       WHERE type = 'episodic'
         AND consolidated_at IS NULL
         AND created_at >= ?1
       ORDER BY topic ASC, created_at ASC`
    )
    .all(windowStart) as EpisodicMemoryRow[]);

  const groups = groupByTopic(eligibleRows);
  let groupsConsolidated = 0;
  let summariesCreated = 0;
  let originalsMarked = 0;
  let skippedGroups = 0;
  const summaryIds: number[] = [];

  for (const [topic, rows] of groups) {
    if (rows.length < minGroupSize) {
      skippedGroups += 1;
      continue;
    }

    const summary = buildSummary(topic, rows);
    const sourceIds = rows.map((row) => row.id);
    const sourceRef = JSON.stringify(sourceIds);
    const salience = computeSummarySalience(rows.length);
    const halfLifeDays = computeSummaryHalfLife(rows.length);

    const placeholders = sourceIds.map(() => "?").join(",");
    const tx = db.transaction(() => {
      const insertResult = db
        .query(
          `INSERT INTO memories (
            text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic, entity, consolidated_from
          ) VALUES (?1, 'semantic', ?2, ?3, unixepoch(), unixepoch(), 0, ?4, NULL, ?5)`
        )
        .run(summary.slice(0, 800), salience, halfLifeDays, topic, sourceRef) as { lastInsertRowid: number | bigint };

      const consolidatedId = Number(insertResult.lastInsertRowid);
      db.query(
        `UPDATE memories
         SET consolidated_at = unixepoch(),
             consolidated_into = ?1
         WHERE id IN (${placeholders})`
      ).run(consolidatedId, ...sourceIds);

      return consolidatedId;
    });

    const consolidatedId = tx();
    groupsConsolidated += 1;
    summariesCreated += 1;
    originalsMarked += sourceIds.length;
    summaryIds.push(consolidatedId);
  }

  db.close();

  return {
    dbPath,
    windowDays,
    scannedRows,
    eligibleRows: eligibleRows.length,
    groupsSeen: groups.size,
    groupsConsolidated,
    summariesCreated,
    originalsMarked,
    skippedGroups,
    summaryIds,
  };
}

if (import.meta.main) {
  try {
    const result = await consolidateMemories();
    console.log(
      `[MEMORY] consolidate db=${result.dbPath} groups=${result.groupsConsolidated}/${result.groupsSeen} summaries=${result.summariesCreated} marked=${result.originalsMarked}`
    );
  } catch (error) {
    console.error("[MEMORY] consolidate failed:", error);
    process.exit(1);
  }
}
