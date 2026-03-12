/**
 * Luna training asset loader
 * Reads files from config/luna-training/ directory
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TRAINING_DIR = join(MODULE_DIR, "..", "config", "luna-training");

const TRAINING_ASSET_MAP: Record<string, string> = {
  "1": "01-safety-limits-consent.md",
  "2": "02-feminization-sissy-slut-mapping.md",
  "3": "03-toys-bondage-latex-anal-chastity.md",
  "4": "04-conditioning-hard-mode-week-plan.md",
  "A": "01-safety-limits-consent.md",
  "B": "02-feminization-sissy-slut-mapping.md",
  "C": "03-toys-bondage-latex-anal-chastity.md",
  "D": "04-conditioning-hard-mode-week-plan.md",
};

export function resolveTrainingAsset(label: string): string {
  const normalized = label.trim().toUpperCase();
  return TRAINING_ASSET_MAP[normalized] || label.trim().toLowerCase();
}

export function readTrainingAsset(filename: string): string | null {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const resolved = join(TRAINING_DIR, safe);
  if (!resolved.startsWith(TRAINING_DIR)) return null;
  if (!existsSync(resolved)) return null;
  return readFileSync(resolved, "utf-8").trim();
}

export function readStoryProtocol(): string | null {
  return readTrainingAsset("story-protocol.md");
}
