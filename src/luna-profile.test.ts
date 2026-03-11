import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addHardLimit,
  addSoftLimit,
  advancePhase,
  getProfileSummary,
  loadProfile,
  updateKinks,
} from "./luna-profile";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.RELAY_DIR;
  delete process.env.LUNA_PROFILE_PATH;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function useTempRelay(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-profile-"));
  tempDirs.push(dir);
  process.env.RELAY_DIR = dir;
  process.env.LUNA_PROFILE_PATH = join(dir, "luna-pafi-profile.json");
  return dir;
}

describe("luna-profile", () => {
  test("creates defaults and persists profile updates", () => {
    useTempRelay();

    const initial = loadProfile();
    expect(initial.training_phase).toBe(0);
    expect(initial.role_identity).toBeNull();

    updateKinks("bondage", { rope: 5, cuffs: 3 });
    addHardLimit("public exposure");
    addSoftLimit("humiliation", "private only");
    advancePhase();

    const updated = loadProfile();
    expect(updated.kinks.bondage.rope).toBe(5);
    expect(updated.hard_limits).toEqual(["public exposure"]);
    expect(updated.soft_limits).toEqual([{ item: "humiliation", conditions: "private only" }]);
    expect(updated.training_phase).toBe(1);
    expect(getProfileSummary()).toContain("rope(5)");
  });
});
