import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { addRadarSourceFromUrl, detectSourceType } from "./radar-add";

describe("radar-add", () => {
  it("detects YouTube channel from URL pattern", async () => {
    const info = await detectSourceType("https://www.youtube.com/@OpenAI");
    expect(info.type).toBe("youtube_channel");
    expect(info.canonical_url).toBe("https://www.youtube.com/@OpenAI");
  });

  it("detects RSS feed from real RSS URL", async () => {
    const info = await detectSourceType("https://www.nasa.gov/rss/dyn/breaking_news.rss");
    expect(info.type).toBe("rss");
  });

  it("adds source to yaml and rejects duplicates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "radar-add-test-"));
    const configPath = join(tempDir, "radar-sources.yaml");

    const first = await addRadarSourceFromUrl("https://www.youtube.com/@OpenAI", configPath);
    expect(first.ok).toBe(true);

    const second = await addRadarSourceFromUrl("https://www.youtube.com/@OpenAI/", configPath);
    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.code).toBe("exists");
    }

    const yaml = await readFile(configPath, "utf-8");
    expect(yaml).toContain("verticals:");
    expect(yaml).toContain("sources:");
  });
});
