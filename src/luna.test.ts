import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractAndSaveMemories, initMemoryDB } from "./memory-fts5";
import { saveProfile } from "./luna-profile";
import {
  activateLuna,
  LUNA_FIRST_MESSAGE,
  resetLunaRuntimeForTests,
  sendToLuna,
} from "./luna";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RELAY_DIR;
  delete process.env.MEMORY_DB_PATH;
  delete process.env.LUNA_STATE_PATH;
  delete process.env.LUNA_PROFILE_PATH;
  delete process.env.LUNA_PREFERENCES_PATH;
  delete process.env.LUNA_TRAINING_DIR;
  resetLunaRuntimeForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function useTempRelay(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-runtime-"));
  const trainingDir = join(dir, "config", "luna-training");
  mkdirSync(trainingDir, { recursive: true });
  writeFileSync(join(trainingDir, "session-3.txt"), "SESSION 3 TEST DIRECTIVE");
  writeFileSync(
    join(dir, "luna-preferences.json"),
    JSON.stringify(
      {
        core_style: "clinical",
        primary_kinks: { rope: 4, "orgasm control": 5 },
        sometimes_activities: [],
        curious_about: [],
        soft_limits: [],
        hard_limits: [],
        preferred_scene_moods: [],
        typical_intensity: "medium",
        aftercare_style: "brief",
      },
      null,
      2
    )
  );
  tempDirs.push(dir);
  process.env.RELAY_DIR = dir;
  process.env.MEMORY_DB_PATH = join(dir, "memory.db");
  process.env.LUNA_STATE_PATH = join(dir, "luna-state.json");
  process.env.LUNA_PROFILE_PATH = join(dir, "luna-pafi-profile.json");
  process.env.LUNA_PREFERENCES_PATH = join(dir, "luna-preferences.json");
  process.env.LUNA_TRAINING_DIR = trainingDir;
  return dir;
}

describe("luna runtime", () => {
  test("sends calibration message only for a new session", () => {
    useTempRelay();

    const first = activateLuna(101);
    const second = activateLuna(101);

    expect(first).toBe(LUNA_FIRST_MESSAGE);
    expect(second).toBeNull();
  });

  test("injects memory and persists chat history", async () => {
    const dir = useTempRelay();
    const { db, sessionId } = initMemoryDB(join(dir, "memory.db"));
    extractAndSaveMemories(
      db,
      "my safeword is yellow and i like rope.",
      "noted.",
      1,
      sessionId,
      "[REMEMBER: the user likes rope and uses yellow as safeword.]"
    );
    db.close();

    activateLuna(202);
    saveProfile({
      role_identity: "submissive",
      core_desires: ["control", "ownership"],
      hard_limits: ["public exposure"],
      soft_limits: [],
      real_life_boundaries: [],
      aftercare_needs: [],
      distress_signals: [],
      training_phase: 3,
      kinks: {
        bondage: { rope: 5 },
        denial: { "orgasm control": 4 },
      },
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

    let payload: any = null;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ message: { content: "good pet 😏" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const reply = await sendToLuna(202, "tell me what you remember.");

    expect(reply).toBe("good pet 😏");
    expect(payload.messages[0].content).toContain("You are writing the character of Luna");
    expect(payload.messages[1].content.includes("[Ce știu despre tine]")).toBe(true);
    expect(payload.messages[2].content.includes("[Profilul lui Pafi:")).toBe(true);
    expect(payload.messages[3].content.includes("[Starea ta actuală:")).toBe(true);
    expect(payload.messages[4].content.includes("[TRAINING DIRECTIVE")).toBe(true);
    expect(payload.messages.at(-1).content.includes("Stay in character as Luna")).toBe(true);

    const { db: readDb } = initMemoryDB(join(dir, "memory.db"), { skipSession: true });
    const rows = readDb
      .query("SELECT role, content FROM luna_sessions WHERE chat_id = ?1 ORDER BY created_at ASC")
      .all(202) as Array<{ role: string; content: string }>;

    expect(rows.map((row) => row.role)).toEqual(["assistant", "user", "assistant"]);
    expect(rows[0]?.content).toBe(LUNA_FIRST_MESSAGE);
    expect(rows[2]?.content).toBe("good pet 😏");
    readDb.close();
  });

  test("injects Luna preferences when the user asks for them", async () => {
    useTempRelay();
    activateLuna(303);

    let payload: any = null;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ message: { content: "noted." } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await sendToLuna(303, "what are you into?");

    expect(payload.messages.some((message: { content: string }) => message.content.includes("[Preferințele mele (Luna):"))).toBe(true);
  });
});
