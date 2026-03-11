import { describe, expect, test } from "bun:test";
import {
  SEMANTIC_TRIGGER_RE,
  extractAndSaveMemories,
  getMemoryContext,
  initMemoryDB,
  reinforceSalience,
} from "./memory-fts5";

describe("SEMANTIC_TRIGGER_RE", () => {
  test("matches required Romanian trigger patterns", () => {
    const phrases = [
      "contul meu principal este x",
      "proiectul Atlas merge bine",
      "echipa are deadline maine",
      "agentul Richard proceseaza queue-ul",
      "regula este sa facem audit",
      "procedura FORGE-01 e activa",
      "preferința mea e standup dimineața",
    ];

    for (const phrase of phrases) {
      expect(SEMANTIC_TRIGGER_RE.test(phrase)).toBe(true);
    }
  });

  test("matches BDSM semantic trigger patterns", () => {
    const phrases = [
      "hard limit: breath play",
      "my safeword is yellow",
      "orgasm denial is a kink for me",
      "preferință: ritual de seară",
      "am o limită clară și un protocol",
    ];

    for (const phrase of phrases) {
      expect(SEMANTIC_TRIGGER_RE.test(phrase)).toBe(true);
    }
  });
});

describe("memory extraction and retrieval", () => {
  test("extracts semantic facts from assistant response and [REMEMBER:] tags", () => {
    const { db, sessionId } = initMemoryDB(":memory:");

    extractAndSaveMemories(
      db,
      "salut",
      "contul meu de lucru este Lis Ops.",
      1,
      sessionId,
      "Am notat [REMEMBER: preferința mea este întâlnire zilnică la 09:00]."
    );

    const semanticRows = db
      .query("SELECT text FROM memories WHERE type = 'semantic' ORDER BY id ASC")
      .all() as Array<{ text: string }>;

    expect(semanticRows.some((row) => row.text.includes("contul meu de lucru"))).toBe(true);
    expect(semanticRows.some((row) => row.text.includes("preferința mea este întâlnire"))).toBe(true);

    db.close();
  });

  test("preserves diacritics in FTS search", () => {
    const { db, sessionId } = initMemoryDB(":memory:");
    extractAndSaveMemories(db, "preferința mea este întâlnire marți la 10.", "confirmat", 1, sessionId);

    const context = getMemoryContext(db, "întâlnire");
    expect(context.includes("întâlnire")).toBe(true);

    db.close();
  });

  test("caps salience and half-life reinforcement", () => {
    const { db } = initMemoryDB(":memory:", { skipSession: true });
    const insert = db
      .query(
        `INSERT INTO memories (text, type, salience, half_life_days, created_at, last_accessed_at, access_count)
         VALUES ('cap-test', 'semantic', 2.95, 360, unixepoch(), unixepoch(), 0)`
      )
      .run() as { lastInsertRowid: number | bigint };
    const memoryId = Number(insert.lastInsertRowid);

    for (let i = 0; i < 20; i += 1) {
      reinforceSalience(db, memoryId);
    }

    const row = db.query("SELECT salience, half_life_days FROM memories WHERE id = ?1").get(memoryId) as
      | { salience: number; half_life_days: number }
      | null;
    expect(row).not.toBeNull();
    expect(Number(row!.salience)).toBeLessThanOrEqual(3.0);
    expect(Number(row!.half_life_days)).toBeLessThanOrEqual(365);

    db.close();
  });

  test("boosts same-topic memories in context retrieval", () => {
    const { db } = initMemoryDB(":memory:", { skipSession: true });
    db.query(
      `INSERT INTO memories (text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic)
       VALUES (?1, 'semantic', 1.0, 110, unixepoch(), unixepoch(), 0, ?2)`
    ).run("deploy hotfix runbook alpha", "pipeline");
    db.query(
      `INSERT INTO memories (text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic)
       VALUES (?1, 'semantic', 1.0, 110, unixepoch(), unixepoch(), 0, ?2)`
    ).run("deploy hotfix runbook beta", "deployment");

    const context = getMemoryContext(db, "pipeline deploy");
    const firstBullet = context
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("• "));

    expect(firstBullet?.includes("alpha")).toBe(true);
    db.close();
  });

  test("creates luna session persistence table", () => {
    const { db } = initMemoryDB(":memory:", { skipSession: true });
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'luna_sessions'")
      .get() as { name: string } | null;

    expect(table?.name).toBe("luna_sessions");
    db.close();
  });
});
