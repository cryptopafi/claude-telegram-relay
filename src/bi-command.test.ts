import { describe, expect, test } from "bun:test";
import { isValidBiSlug, parseBiRunCommand } from "./bi-command";

describe("parseBiRunCommand", () => {
  test("parses all-project runs", () => {
    expect(parseBiRunCommand("/bi-run")).toEqual({ mode: "all", slug: null });
    expect(parseBiRunCommand("/bi_run@claudemacm4_bot")).toEqual({ mode: "all", slug: null });
  });

  test("parses a specific project slug", () => {
    expect(parseBiRunCommand("/bi-run albastru")).toEqual({ mode: "project", slug: "albastru" });
    expect(parseBiRunCommand("/bi_run SEO-group")).toEqual({ mode: "project", slug: "seo-group" });
  });

  test("rejects invalid project slugs", () => {
    expect(parseBiRunCommand("/bi-run ../bad")).toEqual({ mode: "project", slug: null });
  });
});

describe("isValidBiSlug", () => {
  test("accepts lowercase slug tokens", () => {
    expect(isValidBiSlug("smsads")).toBe(true);
    expect(isValidBiSlug("seo-group")).toBe(true);
  });

  test("rejects unsafe slug values", () => {
    expect(isValidBiSlug("seo group")).toBe(false);
    expect(isValidBiSlug("../seo-group")).toBe(false);
  });
});
