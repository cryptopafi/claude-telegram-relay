import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type PafiProfile, saveProfile } from "./luna-profile";
import { getAvailableTasks, logTaskCompletion, selectTask } from "./luna-tasks";

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

function useTempRelay(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-tasks-"));
  tempDirs.push(dir);
  process.env.RELAY_DIR = dir;
  process.env.LUNA_PROFILE_PATH = join(dir, "luna-pafi-profile.json");
  return dir;
}

function buildProfile(): PafiProfile {
  return {
    role_identity: "submissive",
    core_desires: ["control", "ownership"],
    hard_limits: ["verbal humiliation"],
    soft_limits: [],
    real_life_boundaries: [],
    aftercare_needs: [],
    distress_signals: [],
    training_phase: 6,
    kinks: {
      psychological: { control: 5 },
      obedience: { ritual: 4 },
      humiliation: { shame: 2 },
    },
    triggers: {},
    feminization: {
      program_status: "active",
      current_level: "medium",
      identity_nature: "kink_only",
      blacklist: [],
      task_history: [],
    },
    sissy_slut: {},
    inventory: { owned_toys: [] },
    last_updated: new Date().toISOString(),
  };
}

describe("luna-tasks", () => {
  test("filters available tasks and avoids consecutive repeats", () => {
    useTempRelay();
    const profile = buildProfile();

    const available = getAvailableTasks(profile);
    expect(available.length).toBeGreaterThan(0);
    expect(available.some((task) => task.id === "humiliation-script")).toBe(false);

    const first = selectTask(profile);
    const second = selectTask(profile, first.id);

    expect(first.id).toBe("behavioral-mirror");
    expect(second.id).not.toBe(first.id);
  });

  test("logs task completion into the persistent profile", () => {
    useTempRelay();
    const profile = buildProfile();
    saveProfile(profile);

    logTaskCompletion(profile, "behavioral-mirror", {
      response: "I did it.",
      feeling: "focused",
      date: "2026-03-11",
    });

    expect(profile.feminization.task_history).toEqual([
      {
        date: "2026-03-11",
        task: "Practice a short obedience ritual, then journal where resistance appeared and why.",
        response: "I did it.",
        feeling: "focused",
      },
    ]);
  });
});
