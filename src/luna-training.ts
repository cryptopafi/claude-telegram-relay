import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { loadProfile } from "./luna-profile";

function getProjectRoot(): string {
  return dirname(dirname(import.meta.path));
}

export function getTrainingConfigDir(): string {
  return process.env.LUNA_TRAINING_DIR || join(getProjectRoot(), "config", "luna-training");
}

export function readTrainingAsset(fileName: string): string | null {
  const path = join(getTrainingConfigDir(), fileName);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

function shouldIncludeFeminizationMapping(): boolean {
  const profile = loadProfile();
  return (
    profile.feminization.program_status === "active" ||
    profile.feminization.program_status === "paused" ||
    profile.feminization.identity_nature === "flagged_exploration"
  );
}

function primaryDirectiveFile(phase: number): string | null {
  const profile = loadProfile();
  if (phase <= 0) return "session-1.txt";
  if (phase === 1) {
    return profile.hard_limits.length === 0 ? "session-2.txt" : "session-1.txt";
  }
  if (phase === 2) return "session-2.txt";
  if (phase === 3) return "session-3.txt";
  if (phase === 4) return "session-4.txt";
  if (phase === 5) return "session-5.txt";
  if (phase === 6) return "session-6.txt";
  if (phase === 7) return "session-7.txt";
  return null;
}

export function loadTrainingDirective(phase: number): string | null {
  const fileName = primaryDirectiveFile(phase);
  if (!fileName) return null;

  const blocks: string[] = [];
  const primary = readTrainingAsset(fileName);
  if (primary) blocks.push(primary);

  if (phase === 5 && shouldIncludeFeminizationMapping()) {
    const mapping = readTrainingAsset("session-5b.txt");
    if (mapping) blocks.push(mapping);
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
