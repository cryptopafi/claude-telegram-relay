import { describe, expect, test } from "bun:test";
import {
  classifyMessageIntent,
  CortexRulesCache,
  loadContextForMessage,
  type Intent,
} from "./context-loader";

describe("classifyMessageIntent", () => {
  const cases: Array<{ text: string; intent: Intent }> = [
    { text: "ce mai faci azi?", intent: "simple_chat" },
    { text: "scrie cod si repara bugul", intent: "code_task" },
    { text: "research benchmark pentru model", intent: "research_query" },
    { text: "analizeaza competitorii si preturile", intent: "business_question" },
    { text: "restart service si verifica logs", intent: "system_op" },
    { text: "programeaza o intalnire in calendar", intent: "calendar_event" },
    { text: "trimite email clientului", intent: "email_task" },
    { text: "fa audit de securitate", intent: "audit_request" },
  ];

  test("maps EN/RO messages to expected intent", () => {
    for (const item of cases) {
      expect(classifyMessageIntent(item.text)).toBe(item.intent);
    }
  });
});

describe("CortexRulesCache", () => {
  test("reuses cached value within TTL", async () => {
    let calls = 0;
    const cache = new CortexRulesCache(async () => {
      calls += 1;
      return "RULES";
    }, 60_000);

    expect(await cache.getRules()).toBe("RULES");
    expect(await cache.getRules()).toBe("RULES");
    expect(calls).toBe(1);
  });

  test("expires after TTL", async () => {
    let calls = 0;
    const cache = new CortexRulesCache(async () => {
      calls += 1;
      return `RULES-${calls}`;
    }, 1);

    expect(await cache.getRules()).toBe("RULES-1");
    await Bun.sleep(5);
    expect(await cache.getRules()).toBe("RULES-2");
    expect(calls).toBe(2);
  });
});

describe("loadContextForMessage", () => {
  test("loads tier 0 + 1 for simple chat", async () => {
    const context = await loadContextForMessage(
      "salut",
      "simple_chat",
      [{ role: "user", content: "hello" }],
      {
        systemPromptTemplate: "<xml>{{CURRENT_TIME}} {{SESSION_LIVE}} {{SENTINEL_HEALTH}}</xml>",
        loadCortexRules: async () => "RULES",
        loadMemorySummary: () => "Memory summary",
        loadSessionLive: async () => "Live session",
      }
    );

    expect(context.tier).toBe(1);
    expect(context.totalChars).toBeGreaterThan(0);
    expect(context.contextBlocks.some((block) => block.includes("[Tier 2]"))).toBe(false);
    expect(context.contextBlocks.some((block) => block.includes("[Tier 1] Intent Hint:"))).toBe(true);
  });

  test("loads tier 2 for research/audit/business intents", async () => {
    const context = await loadContextForMessage(
      "research this",
      "research_query",
      [{ role: "user", content: "research this" }],
      {
        systemPromptTemplate: "<xml>{{CURRENT_TIME}}</xml>",
        loadCortexRules: async () => "RULES",
        loadMemorySummary: () => "Memory summary",
        loadSessionLive: async () => "Live session",
        loadCortexContext: async () => "Deep context",
        loadCortexProcedures: async () => "Procedure context",
        loadSentinelHealth: async () => "Sentinel health",
        loadSharedMemory: async () => "Full memory",
      }
    );

    expect(context.tier).toBe(2);
    expect(context.contextBlocks.some((block) => block.includes("[Tier 2] Cortex Deep Context:"))).toBe(true);
    expect(context.contextBlocks.some((block) => block.includes("[Tier 2] SENTINEL Health:"))).toBe(true);
  });
});
