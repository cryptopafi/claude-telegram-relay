import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getMoodBlock,
  getMoodState,
  getRelationshipState,
  updateMoodState,
  updateRelationshipState,
} from "./luna-state";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.LUNA_STATE_PATH;
  delete process.env.RELAY_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function useTempState(): void {
  const dir = mkdtempSync(join(tmpdir(), "luna-state-"));
  tempDirs.push(dir);
  process.env.RELAY_DIR = dir;
  process.env.LUNA_STATE_PATH = join(dir, "luna-state.json");
}

describe("luna-state", () => {
  test("creates a readable mood block with time-of-day baseline", () => {
    useTempState();

    const mood = getMoodState();
    const block = getMoodBlock();

    expect(typeof mood.valence).toBe("number");
    expect(block.startsWith("[Starea ta actuală:")).toBe(true);
  });

  test("updates mood and relationship state without exceeding bounds", () => {
    useTempState();

    const mood = updateMoodState("i trust you. i want more intensity now.", "good pet 😏 breathe.");
    const relationship = updateRelationshipState("vulnerable");

    expect(mood.valence).toBeGreaterThanOrEqual(-1);
    expect(mood.valence).toBeLessThanOrEqual(1);
    expect(mood.arousal).toBeGreaterThanOrEqual(0);
    expect(mood.arousal).toBeLessThanOrEqual(1);
    expect(mood.dominance).toBeGreaterThanOrEqual(0);
    expect(mood.dominance).toBeLessThanOrEqual(1);
    expect(["stranger", "acquaintance", "friend", "close", "intimate"]).toContain(relationship.stage);
    expect(getRelationshipState().trust).toBeGreaterThanOrEqual(relationship.trust);
  });
});
