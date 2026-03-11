import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initMemoryDB } from "./memory-fts5";
import { consolidateMemories } from "./memory-consolidate";

describe("consolidateMemories", () => {
  test("groups episodic memories by topic and marks originals as consolidated", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lis-memory-consolidate-"));
    const dbPath = join(tempDir, "memory.db");
    const now = Math.floor(Date.now() / 1000);

    try {
      const { db } = initMemoryDB(dbPath, { skipSession: true });
      const insertEpisodic = db.query(
        `INSERT INTO memories (
          text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic
        ) VALUES (?1, 'episodic', ?2, 7, ?3, ?3, 0, ?4)`
      );

      insertEpisodic.run("User: facem deploy | Assistant: facem deploy", 1.4, now - 600, "pipeline");
      insertEpisodic.run("User: checklist | Assistant: checklist deploy final", 1.2, now - 300, "pipeline");
      insertEpisodic.run("User: monitorizare | Assistant: monitorizare dupa deploy", 1.1, now - 120, "pipeline");
      insertEpisodic.run("User: random | Assistant: task izolat", 1.0, now - 60, "general");
      db.close();

      const result = await consolidateMemories({
        dbPath,
        nowEpoch: now,
        windowDays: 30,
        minGroupSize: 2,
      });

      expect(result.groupsConsolidated).toBeGreaterThanOrEqual(1);
      expect(result.summariesCreated).toBeGreaterThanOrEqual(1);
      expect(result.originalsMarked).toBe(3);

      const { db: readDb } = initMemoryDB(dbPath, { skipSession: true });
      const summary = readDb.query(
        `SELECT id, text, topic, consolidated_from
         FROM memories
         WHERE type = 'semantic'
           AND consolidated_from IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`
      ).get() as { id: number; text: string; topic: string | null; consolidated_from: string } | null;

      expect(summary).not.toBeNull();
      expect(summary!.topic).toBe("pipeline");
      expect(summary!.text.includes("pipeline: 3 interactions")).toBe(true);

      const sourceIds = JSON.parse(summary!.consolidated_from) as number[];
      expect(sourceIds.length).toBe(3);

      const marked = readDb.query(
        `SELECT COUNT(*) AS n
         FROM memories
         WHERE consolidated_into = ?1
           AND type = 'episodic'`
      ).get(summary!.id) as { n: number } | null;
      expect(Number(marked?.n || 0)).toBe(3);

      readDb.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
