import { describe, expect, test } from "bun:test";
import {
  buildNexusCompletionMessage,
  fallbackNexusTopicFromUrl,
  isNexusUrlTopic,
  keywordsFromTopic,
  parseNexusCommand,
} from "./nexus-command";

describe("parseNexusCommand", () => {
  test("parses standard topic", () => {
    expect(parseNexusCommand("/nexus ai agents")).toEqual({
      depth: "standard",
      topic: "ai agents",
    });
  });

  test("parses deep and opus aliases", () => {
    expect(parseNexusCommand("/nexus deep inference stack")).toEqual({
      depth: "deep",
      topic: "inference stack",
    });
    expect(parseNexusCommand("/nexus opus pricing")).toEqual({
      depth: "deep",
      topic: "pricing",
    });
  });

  test("parses telegram bot mention form", () => {
    expect(parseNexusCommand("/nexus@claudemacm4_bot deep market maps")).toEqual({
      depth: "deep",
      topic: "market maps",
    });
  });
});

describe("keywordsFromTopic", () => {
  test("deduplicates and strips short fragments", () => {
    expect(keywordsFromTopic("AI agent AI ops for GTM in 2026")).toBe("agent,ops,for,gtm,2026");
  });
});

describe("nexus url helpers", () => {
  test("detects direct URLs", () => {
    expect(isNexusUrlTopic("https://example.com/path")).toBe(true);
    expect(isNexusUrlTopic("AI agents 2025")).toBe(false);
  });

  test("builds fallback topic from URL host and path", () => {
    expect(fallbackNexusTopicFromUrl("https://www.instagram.com/p/DVRFb5TDPqN/")).toBe("instagram.com/p/DVRFb5TDPqN");
  });
});

describe("buildNexusCompletionMessage", () => {
  test("escapes markdown and truncates summary", () => {
    const summary = "Alpha_beta [gamma] path!";
    expect(buildNexusCompletionMessage("deep", summary, "/tmp/a_b.md")).toBe(
      "*NEXUS deep*\nAlpha\\_beta \\[gamma\\] path\\!\n\nPath: `/tmp/a\\_b\\.md`"
    );
  });
});
