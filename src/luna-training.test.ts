import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveProfile } from "./luna-profile";
import { loadTrainingDirective } from "./luna-training";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.RELAY_DIR;
  delete process.env.LUNA_PROFILE_PATH;
  delete process.env.LUNA_TRAINING_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setupTempEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-training-"));
  const trainingDir = join(dir, "config", "luna-training");
  mkdirSync(trainingDir, { recursive: true });
  writeFileSync(join(trainingDir, "session-1.txt"), "S1");
  writeFileSync(join(trainingDir, "session-2.txt"), "S2");
  writeFileSync(join(trainingDir, "session-5.txt"), "S5");
  writeFileSync(join(trainingDir, "session-5b.txt"), "S5B");
  writeFileSync(join(trainingDir, "session-7.txt"), "S7");
  tempDirs.push(dir);
  process.env.RELAY_DIR = dir;
  process.env.LUNA_PROFILE_PATH = join(dir, "luna-pafi-profile.json");
  process.env.LUNA_TRAINING_DIR = trainingDir;
  return dir;
}

describe("luna-training", () => {
  test("maps phase one without hard limits to session 2", () => {
    setupTempEnv();
    saveProfile({
      role_identity: null,
      core_desires: [],
      hard_limits: [],
      soft_limits: [],
      real_life_boundaries: [],
      aftercare_needs: [],
      distress_signals: [],
      training_phase: 1,
      kinks: {},
      triggers: {},
      feminization: {
        program_status: "inactive",
        current_level: "light",
        identity_nature: "kink_only",
        blacklist: [],
        task_history: [],
      },
      sissy_slut: {},
      inventory: { owned_toys: [] },
      last_updated: new Date().toISOString(),
    });

    expect(loadTrainingDirective(1)).toBe("S2");
  });

  test("appends session 5b when feminization mapping is active", () => {
    setupTempEnv();
    saveProfile({
      role_identity: null,
      core_desires: [],
      hard_limits: ["needle play"],
      soft_limits: [],
      real_life_boundaries: [],
      aftercare_needs: [],
      distress_signals: [],
      training_phase: 5,
      kinks: {},
      triggers: {},
      feminization: {
        program_status: "active",
        current_level: "medium",
        identity_nature: "flagged_exploration",
        blacklist: [],
        task_history: [],
      },
      sissy_slut: {},
      inventory: { owned_toys: [] },
      last_updated: new Date().toISOString(),
    });

    expect(loadTrainingDirective(5)).toBe("S5\n\nS5B");
    expect(loadTrainingDirective(7)).toBe("S7");
    expect(loadTrainingDirective(8)).toBeNull();
  });
});
