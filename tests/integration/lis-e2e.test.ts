import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { classifyMessage, initDispatch, TaskType } from "../../src/dispatch";
import { __resetDedupForTests, isDuplicate, markProcessed } from "../../src/dispatch-dedup";
import { __refreshFlagsForTests } from "../../src/feature-flags";
import { classifyMessageIntent, loadContextForMessage, type ContextLoaderDeps } from "../../src/context-loader";
import { consolidateMemories } from "../../src/memory-consolidate";
import { extractAndSaveMemories, getMemoryContext, initMemoryDB, SEMANTIC_TRIGGER_RE } from "../../src/memory-fts5";
import { detectCommitment, extractDeadline } from "../../src/proactive/followup-tracker";
import { extractDoneLines } from "../../src/proactive/smart-checkin";

let tempDir = "";
let telemetryPath = "";
let telemetryModule: typeof import("../../src/telemetry");

const ORIGINAL_ENV = {
  FEATURE_SMART_DISPATCH: process.env.FEATURE_SMART_DISPATCH,
  FEATURE_CONTEXT_OPTIMIZATION: process.env.FEATURE_CONTEXT_OPTIMIZATION,
  FEATURE_MEMORY_EVOLUTION: process.env.FEATURE_MEMORY_EVOLUTION,
  FEATURE_PROACTIVE: process.env.FEATURE_PROACTIVE,
  FEATURE_FACT_CHECK: process.env.FEATURE_FACT_CHECK,
  RELAY_TELEMETRY_PATH: process.env.RELAY_TELEMETRY_PATH,
};

const REAL_DATE_NOW = Date.now;

function setFlag(name: keyof typeof ORIGINAL_ENV, enabled: boolean): void {
  process.env[name] = enabled ? "true" : "false";
  __refreshFlagsForTests();
}

function resetFlags(): void {
  process.env.FEATURE_SMART_DISPATCH = "false";
  process.env.FEATURE_CONTEXT_OPTIMIZATION = "false";
  process.env.FEATURE_MEMORY_EVOLUTION = "false";
  process.env.FEATURE_PROACTIVE = "false";
  process.env.FEATURE_FACT_CHECK = "false";
  __refreshFlagsForTests();
}

async function withFakeNow<T>(now: number, fn: () => Promise<T> | T): Promise<T> {
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = REAL_DATE_NOW;
  }
}

function makeContextDeps(overrides: Partial<ContextLoaderDeps> = {}): ContextLoaderDeps {
  return {
    systemPromptTemplate: "<system>{{CURRENT_TIME}}</system>",
    loadCortexRules: async () => "RULE-H-001",
    loadMemorySummary: () => "Pafi prefers concise operational summaries.",
    loadSessionLive: async () => "SESSION-LIVE: relay integration work in progress",
    loadCortexContext: async () => "- Deep context block",
    loadCortexProcedures: async () => "1. Procedure block",
    loadSentinelHealth: async () => "SENTINEL: healthy",
    loadSharedMemory: async () => "## System\nStable system memory",
    ...overrides,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "lis-e2e-"));
  telemetryPath = join(tempDir, "relay-telemetry.jsonl");
  process.env.RELAY_TELEMETRY_PATH = telemetryPath;
  telemetryModule = await import("../../src/telemetry");
});

beforeEach(() => {
  __resetDedupForTests();
  resetFlags();
});

afterAll(async () => {
  Date.now = REAL_DATE_NOW;

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  __refreshFlagsForTests();

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("lis end-to-end integration", () => {
  it("runs the full research message pipeline with telemetry and dedup TTL", async () => {
    setFlag("FEATURE_SMART_DISPATCH", true);
    setFlag("FEATURE_CONTEXT_OPTIMIZATION", true);
    setFlag("FEATURE_MEMORY_EVOLUTION", true);

    const message = "research Bun runtime latency and compare the fastest relay adapters";
    const classification = classifyMessage(message);
    expect(classification.type).toBe(TaskType.RESEARCH);
    expect(classification.confidence).toBeGreaterThan(0.6);

    const intent = classifyMessageIntent(message);
    expect(intent).toBe("research_query");

    const context = await loadContextForMessage(
      message,
      intent,
      [{ role: "user", content: message }],
      makeContextDeps({
        loadCortexContext: async () => "- Decision: prefer cached context",
        loadCortexProcedures: async () => "1. Procedure: hit Cortex before coding",
      })
    );

    expect(context.tier).toBe(2);
    expect(context.contextBlocks.some((block) => block.includes("[Tier 2] Cortex Deep Context:"))).toBe(true);
    expect(context.contextBlocks.some((block) => block.includes("prefer cached context"))).toBe(true);

    telemetryModule.startTrace("research-msg-1");
    await Bun.sleep(5);
    await telemetryModule.endTrace("research-msg-1", {
      userId: "pafi",
      messageType: "research",
      tokensUsed: 321,
      model: "claude-local-test",
      featuresActive: ["FEATURE_SMART_DISPATCH", "FEATURE_CONTEXT_OPTIMIZATION"],
      buildPromptMs: 35,
      factCheckMs: 0,
    });

    expect(existsSync(telemetryPath)).toBe(true);
    const telemetryLines = (await readFile(telemetryPath, "utf-8")).trim().split("\n").filter(Boolean);
    expect(telemetryLines.length).toBeGreaterThanOrEqual(1);
    const lastTelemetry = JSON.parse(telemetryLines.at(-1) || "{}") as {
      user_id?: string;
      message_type?: string;
      features_active?: string[];
      latency_ms?: number;
    };
    expect(lastTelemetry.user_id).toBe("pafi");
    expect(lastTelemetry.message_type).toBe("research");
    expect(lastTelemetry.features_active).toContain("FEATURE_SMART_DISPATCH");
    expect(Number(lastTelemetry.latency_ms)).toBeGreaterThanOrEqual(0);

    const baseTime = Date.parse("2026-03-11T10:00:00.000Z");
    await withFakeNow(baseTime, async () => {
      expect(isDuplicate(message)).toBe(false);
      markProcessed(message);
      expect(isDuplicate(message)).toBe(true);
    });
    await withFakeNow(baseTime + 4 * 60_000, async () => {
      expect(isDuplicate(message)).toBe(true);
    });
    await withFakeNow(baseTime + 5 * 60_000 + 1, async () => {
      expect(isDuplicate(message)).toBe(false);
    });
  });

  it("routes a code task through a mocked Codex adapter and blocks duplicates", async () => {
    setFlag("FEATURE_SMART_DISPATCH", true);

    const message = "please write a function to parse relay JSON and fix bug in the adapter";
    const classification = classifyMessage(message);
    expect(classification.type).toBe(TaskType.CODE);
    expect(classification.confidence).toBeGreaterThan(0.6);

    let adapterCalls = 0;
    const dispatch = initDispatch(
      {},
      async () => {},
      {
        [TaskType.CODE]: async () => {
          adapterCalls += 1;
          return {
            handled: true,
            skipClaude: true,
            response: "mock codex handled",
          };
        },
      }
    );

    const firstResult = await dispatch.handle(message, "chat-code");
    expect(firstResult.handled).toBe(true);
    expect(firstResult.skipClaude).toBe(true);
    expect(firstResult.response).toBe("mock codex handled");
    expect(adapterCalls).toBe(1);
    expect(isDuplicate(message)).toBe(true);

    const duplicateResult = await dispatch.handle(message, "chat-code");
    expect(duplicateResult.handled).toBe(true);
    expect(duplicateResult.skipClaude).toBe(true);
    expect(duplicateResult.response).toContain("Duplicate task detected");
    expect(adapterCalls).toBe(1);
  });

  it("stores and recalls semantic memory through FTS5, then consolidates episodic memory", async () => {
    const dbPath = join(tempDir, "memory-roundtrip.sqlite");
    const { db, sessionId } = initMemoryDB(dbPath);
    const rememberedText = "Pafi prefers SSH for git";
    const semanticTriggerText = `remember ${rememberedText}`;

    expect(SEMANTIC_TRIGGER_RE.test(semanticTriggerText)).toBe(true);

    extractAndSaveMemories(db, "noted", "Noted.", 1, sessionId, `[REMEMBER: ${rememberedText}]`);

    const now = Math.floor(Date.now() / 1000);
    const insertEpisodic = db.query(
      `INSERT INTO memories (
        text, type, salience, half_life_days, created_at, last_accessed_at, access_count, topic
      ) VALUES (?1, 'episodic', ?2, 7, ?3, ?3, 0, ?4)`
    );
    insertEpisodic.run("User: git auth | Assistant: Use SSH keys", 1.2, now - 300, "git");
    insertEpisodic.run("User: repo auth | Assistant: SSH is preferred", 1.1, now - 120, "git");

    const recalled = getMemoryContext(db, "git auth preference");
    expect(recalled).toContain(rememberedText);

    db.close();

    const consolidation = await consolidateMemories({
      dbPath,
      nowEpoch: now,
      windowDays: 30,
      minGroupSize: 2,
    });
    expect(consolidation.summariesCreated).toBeGreaterThanOrEqual(1);
    expect(consolidation.originalsMarked).toBeGreaterThanOrEqual(2);
  });

  it("honors FEATURE_SMART_DISPATCH gating", async () => {
    const message = "write a function to validate relay payloads and fix bug";
    let adapterCalls = 0;

    const dispatch = initDispatch(
      {},
      async () => {},
      {
        [TaskType.CODE]: async () => {
          adapterCalls += 1;
          return {
            handled: true,
            skipClaude: true,
            response: "dispatched",
          };
        },
      }
    );

    setFlag("FEATURE_SMART_DISPATCH", false);
    const disabledResult = await dispatch.handle(message, "chat-flags");
    expect(disabledResult).toEqual({ handled: false, skipClaude: false });
    expect(adapterCalls).toBe(0);
    expect(isDuplicate(message)).toBe(false);

    setFlag("FEATURE_SMART_DISPATCH", true);
    const enabledResult = await dispatch.handle(message, "chat-flags");
    expect(enabledResult.handled).toBe(true);
    expect(enabledResult.skipClaude).toBe(true);
    expect(adapterCalls).toBe(1);
  });

  it("detects proactive follow-ups and Codex DONE lines", () => {
    setFlag("FEATURE_PROACTIVE", true);

    const message = "I'll send the report tomorrow";
    expect(detectCommitment(message)).toBe(true);
    expect(extractDeadline(message)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const doneLines = extractDoneLines(`
      [2026-03-11] [m4-442 DONE]: context loader shipped
      random line
      [2026-03-11] [m4-443 BLOCKED]: ignored here
    `);
    expect(doneLines).toEqual(["[2026-03-11] [m4-442 DONE]: context loader shipped"]);
  });

  it("escalates context from Tier 1 simple chat to Tier 2 research context", async () => {
    setFlag("FEATURE_CONTEXT_OPTIMIZATION", true);

    const deps = makeContextDeps({
      loadCortexContext: async () => "- Deep context A\n- Deep context B",
      loadCortexProcedures: async () => "1. Procedure A\n2. Procedure B",
      loadSharedMemory: async () => "## System\nStable\n\n## Topic Index\nRelay context",
    });

    const simpleContext = await loadContextForMessage("hello there", "simple_chat", [], deps);
    const researchContext = await loadContextForMessage(
      "research the relay memory pipeline",
      "research_query",
      [],
      deps
    );

    expect(simpleContext.tier).toBe(1);
    expect(researchContext.tier).toBe(2);
    expect(simpleContext.contextBlocks.some((block) => block.includes("[Tier 2]"))).toBe(false);
    expect(researchContext.contextBlocks.some((block) => block.includes("[Tier 2] Cortex Deep Context:"))).toBe(true);
    expect(researchContext.contextBlocks.length).toBeGreaterThan(simpleContext.contextBlocks.length);
  });
});
