import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSharedMemoryContext,
  classifyMessageIntent,
  CortexRulesCache,
  defaultLoadCortexContext,
  defaultLoadCortexProcedures,
  loadContextForMessage,
  type Intent,
} from "./context-loader";

const originalFetch = globalThis.fetch;

const MEMORY_FIXTURE = `
## System
System details

## Telegram
Telegram details

## Projects: see tracker
Project details

## Latest Session (older in history)
Latest session details

## Training Procedures (1,028 total)
Training details

## Failsafe
Failsafe details

## Auto-Sync
Auto-sync details

## Codex & Ollama: see codex-reference
Codex details

## Albastru & Origini — Master Profile
Profile details

## Custom Triggers
Trigger details

## Topic Index
Topic details
`.trim();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  test("selects relevant shared memory sections per intent", () => {
    const researchMemory = buildSharedMemoryContext(MEMORY_FIXTURE, "research_query");
    expect(researchMemory).toContain("## System");
    expect(researchMemory).toContain("## Failsafe");
    expect(researchMemory).toContain("## Latest Session");
    expect(researchMemory).toContain("## Topic Index");
    expect(researchMemory).toContain("## Training Procedures");
    expect(researchMemory).not.toContain("## Codex & Ollama");
    expect(researchMemory).not.toContain("## Telegram");

    const businessMemory = buildSharedMemoryContext(MEMORY_FIXTURE, "business_question");
    expect(businessMemory).toContain("## Projects");
    expect(businessMemory).toContain("## Albastru & Origini");
    expect(businessMemory).not.toContain("## Topic Index");
  });

  test("selects codex sections for code tasks and stays within the limit", () => {
    const limitedMemory = buildSharedMemoryContext(MEMORY_FIXTURE, "code_task", 120);

    expect(limitedMemory).toContain("## System");
    expect(limitedMemory).toContain("## Failsafe");
    expect(limitedMemory.length).toBeLessThanOrEqual(120);
  });

  test("returns empty strings when cortex search fetch fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(defaultLoadCortexContext("research relay")).resolves.toBe("");
    await expect(defaultLoadCortexProcedures("research relay")).resolves.toBe("");
  });

  test("uses default cortex loaders in tier 2 when deps are omitted", async () => {
    const requests: Array<{ collection: string; limit: number; query: string }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      requests.push(body);

      if (body.collection === "decisions") {
        return new Response(
          JSON.stringify({
            results: [
              {
                text: "Decision Alpha\nUse the selective memory loader for deep context",
                metadata: { title: "Decision Alpha" },
                score: 0.91,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (body.collection === "procedures") {
        return new Response(
          JSON.stringify({
            results: [
              {
                text: "Procedure Beta\nPOST /api/search with a timeout",
                metadata: { title: "Procedure Beta" },
                score: 0.88,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const context = await loadContextForMessage("research relay cortex", "research_query", [], {
      systemPromptTemplate: "<xml>{{CURRENT_TIME}}</xml>",
      loadCortexRules: async () => "RULES",
      loadMemorySummary: () => "Memory summary",
      loadSessionLive: async () => "Live session",
      loadSentinelHealth: async () => "Sentinel health",
      loadSharedMemory: async () => "## System\nShared memory",
    });

    expect(context.tier).toBe(2);
    expect(context.contextBlocks.some((block) => block.includes("- Decision Alpha: Use the selective memory loader"))).toBe(
      true
    );
    expect(context.contextBlocks.some((block) => block.includes("1. Procedure Beta - POST /api/search with a timeout"))).toBe(
      true
    );
    expect(requests).toEqual([
      { collection: "decisions", limit: 5, query: "research relay cortex" },
      { collection: "procedures", limit: 3, query: "research relay cortex" },
    ]);
  });
});
