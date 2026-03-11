import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface LunaPreferences {
  core_style: string;
  primary_kinks: Record<string, number>;
  sometimes_activities: string[];
  curious_about: string[];
  soft_limits: string[];
  hard_limits: string[];
  preferred_scene_moods: string[];
  typical_intensity: string;
  aftercare_style: string;
}

function getRelayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}

function getPreferencesPath(): string {
  return process.env.LUNA_PREFERENCES_PATH || join(getRelayDir(), "luna-preferences.json");
}

function defaultPreferences(): LunaPreferences {
  return {
    core_style: "[FILL]",
    primary_kinks: {},
    sometimes_activities: [],
    curious_about: [],
    soft_limits: [],
    hard_limits: [],
    preferred_scene_moods: [],
    typical_intensity: "[FILL]",
    aftercare_style: "[FILL]",
  };
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, path);
}

export function loadLunaPreferences(): LunaPreferences {
  const path = getPreferencesPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<LunaPreferences>;
    return {
      ...defaultPreferences(),
      ...parsed,
      primary_kinks:
        parsed?.primary_kinks && typeof parsed.primary_kinks === "object" ? parsed.primary_kinks : {},
      sometimes_activities: Array.isArray(parsed?.sometimes_activities) ? parsed.sometimes_activities : [],
      curious_about: Array.isArray(parsed?.curious_about) ? parsed.curious_about : [],
      soft_limits: Array.isArray(parsed?.soft_limits) ? parsed.soft_limits : [],
      hard_limits: Array.isArray(parsed?.hard_limits) ? parsed.hard_limits : [],
      preferred_scene_moods: Array.isArray(parsed?.preferred_scene_moods) ? parsed.preferred_scene_moods : [],
    };
  } catch {
    const defaults = defaultPreferences();
    writeAtomically(path, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

export function getLunaPreferenceBlock(): string {
  const preferences = loadLunaPreferences();
  const primary = Object.entries(preferences.primary_kinks)
    .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([name, rating]) => `${name}=${rating}`);

  const parts = [
    primary.length > 0 ? primary.join(", ") : "no mapped kinks yet",
    preferences.core_style !== "[FILL]" ? `style=${preferences.core_style}` : "",
    preferences.typical_intensity !== "[FILL]" ? `intensity=${preferences.typical_intensity}` : "",
    preferences.aftercare_style !== "[FILL]" ? `aftercare=${preferences.aftercare_style}` : "",
  ].filter(Boolean);

  return `[Preferințele mele (Luna): ${parts.join(", ")}]`;
}
