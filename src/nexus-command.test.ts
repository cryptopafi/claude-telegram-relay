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
      mode: "manual",
    });
  });

  test("parses deep mode", () => {
    expect(parseNexusCommand("/nexus deep inference stack")).toEqual({
      depth: "deep",
      topic: "inference stack",
      mode: "manual",
    });
  });

  test("keeps non-deep modifiers as literal topic text", () => {
    expect(parseNexusCommand("/nexus opus pricing")).toEqual({
      depth: "standard",
      topic: "opus pricing",
      mode: "manual",
    });
  });

  test("parses telegram bot mention form", () => {
    expect(parseNexusCommand("/nexus@claudemacm4_bot deep market maps")).toEqual({
      depth: "deep",
      topic: "market maps",
      mode: "manual",
    });
  });

  test("parses auto mode variants", () => {
    expect(parseNexusCommand("/nexus auto test topic")).toEqual({
      depth: "standard",
      topic: "test topic",
      mode: "auto",
    });
    expect(parseNexusCommand("/nexus auto deep market maps")).toEqual({
      depth: "deep",
      topic: "market maps",
      mode: "auto",
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
