import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface PafiProfile {
  role_identity: string | null;
  core_desires: string[];
  hard_limits: string[];
  soft_limits: Array<{ item: string; conditions: string }>;
  real_life_boundaries: string[];
  aftercare_needs: string[];
  distress_signals: string[];
  training_phase: number;
  kinks: Record<string, Record<string, number>>;
  triggers: Record<string, string>;
  feminization: {
    program_status: "inactive" | "active" | "paused" | "stopped";
    current_level: "light" | "medium" | "deep";
    identity_nature: "kink_only" | "flagged_exploration";
    blacklist: string[];
    task_history: Array<{ date: string; task: string; response: string; feeling: string }>;
  };
  sissy_slut: Record<string, any>;
  inventory: { owned_toys: string[] };
  last_updated: string;
}

function getRelayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}

function getProfilePath(): string {
  return process.env.LUNA_PROFILE_PATH || join(getRelayDir(), "luna-pafi-profile.json");
}

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = typeof value === "string" ? value.trim() : "";
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeSoftLimits(values: unknown): PafiProfile["soft_limits"] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: PafiProfile["soft_limits"] = [];
  for (const value of values) {
    const item = typeof value?.item === "string" ? value.item.trim() : "";
    const conditions = typeof value?.conditions === "string" ? value.conditions.trim() : "";
    if (!item) continue;
    const key = `${item.toLowerCase()}::${conditions.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ item, conditions });
  }
  return result;
}

function normalizeKinks(value: unknown): PafiProfile["kinks"] {
  if (!value || typeof value !== "object") return {};
  const result: PafiProfile["kinks"] = {};
  for (const [domain, items] of Object.entries(value as Record<string, unknown>)) {
    if (!items || typeof items !== "object") continue;
    const normalizedDomain: Record<string, number> = {};
    for (const [item, rating] of Object.entries(items as Record<string, unknown>)) {
      if (typeof item !== "string" || !item.trim()) continue;
      const numeric = Math.max(0, Math.min(5, Number(rating) || 0));
      normalizedDomain[item.trim()] = numeric;
    }
    if (Object.keys(normalizedDomain).length > 0) {
      result[domain.trim()] = normalizedDomain;
    }
  }
  return result;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!normalizedKey || !normalizedValue) continue;
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function buildDefaultProfile(): PafiProfile {
  return {
    role_identity: null,
    core_desires: [],
    hard_limits: [],
    soft_limits: [],
    real_life_boundaries: [],
    aftercare_needs: [],
    distress_signals: [],
    training_phase: 0,
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
    last_updated: isoNow(),
  };
}

function normalizeProfile(input: unknown): PafiProfile {
  const defaults = buildDefaultProfile();
  const source = input && typeof input === "object" ? (input as Record<string, any>) : {};

  return {
    role_identity: typeof source.role_identity === "string" && source.role_identity.trim() ? source.role_identity.trim() : null,
    core_desires: normalizeArray(source.core_desires),
    hard_limits: normalizeArray(source.hard_limits),
    soft_limits: normalizeSoftLimits(source.soft_limits),
    real_life_boundaries: normalizeArray(source.real_life_boundaries),
    aftercare_needs: normalizeArray(source.aftercare_needs),
    distress_signals: normalizeArray(source.distress_signals),
    training_phase: Math.max(0, Math.min(8, Number(source.training_phase) || 0)),
    kinks: normalizeKinks(source.kinks),
    triggers: normalizeStringMap(source.triggers),
    feminization: {
      program_status:
        source.feminization?.program_status === "active" ||
        source.feminization?.program_status === "paused" ||
        source.feminization?.program_status === "stopped"
          ? source.feminization.program_status
          : defaults.feminization.program_status,
      current_level:
        source.feminization?.current_level === "medium" || source.feminization?.current_level === "deep"
          ? source.feminization.current_level
          : defaults.feminization.current_level,
      identity_nature:
        source.feminization?.identity_nature === "flagged_exploration"
          ? "flagged_exploration"
          : defaults.feminization.identity_nature,
      blacklist: normalizeArray(source.feminization?.blacklist),
      task_history: Array.isArray(source.feminization?.task_history)
        ? source.feminization.task_history
            .map((entry: Record<string, unknown>) => ({
              date: typeof entry?.date === "string" && entry.date.trim() ? entry.date.trim() : isoNow(),
              task: typeof entry?.task === "string" ? entry.task.trim() : "",
              response: typeof entry?.response === "string" ? entry.response.trim() : "",
              feeling: typeof entry?.feeling === "string" ? entry.feeling.trim() : "",
            }))
            .filter((entry: { task: string }) => Boolean(entry.task))
        : [],
    },
    sissy_slut: source.sissy_slut && typeof source.sissy_slut === "object" ? source.sissy_slut : {},
    inventory: {
      owned_toys: normalizeArray(source.inventory?.owned_toys),
    },
    last_updated: typeof source.last_updated === "string" && source.last_updated.trim() ? source.last_updated : defaults.last_updated,
  };
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, content);
  renameSync(tempPath, path);
}

function flattenTopKinks(profile: PafiProfile): Array<{ label: string; rating: number }> {
  const pairs: Array<{ label: string; rating: number }> = [];
  for (const [domain, items] of Object.entries(profile.kinks)) {
    for (const [item, rating] of Object.entries(items)) {
      pairs.push({ label: `${item}`, rating: Number(rating) || 0 });
      if (item.toLowerCase() !== domain.toLowerCase()) {
        pairs.push({ label: `${domain}:${item}`, rating: Number(rating) || 0 });
      }
    }
  }
  pairs.sort((left, right) => right.rating - left.rating || left.label.localeCompare(right.label));
  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = pair.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function loadProfile(): PafiProfile {
  const path = getProfilePath();
  try {
    return normalizeProfile(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    const defaults = buildDefaultProfile();
    saveProfile(defaults);
    return defaults;
  }
}

export function saveProfile(profile: PafiProfile): void {
  const path = getProfilePath();
  const normalized = normalizeProfile({
    ...profile,
    last_updated: isoNow(),
  });
  writeAtomically(path, JSON.stringify(normalized, null, 2));
}

export function updateKinks(domain: string, items: Record<string, number>): void {
  const normalizedDomain = domain.trim();
  if (!normalizedDomain) return;
  const profile = loadProfile();
  const nextItems: Record<string, number> = {
    ...(profile.kinks[normalizedDomain] || {}),
  };
  for (const [item, rating] of Object.entries(items || {})) {
    const key = item.trim();
    if (!key) continue;
    nextItems[key] = Math.max(0, Math.min(5, Number(rating) || 0));
  }
  profile.kinks[normalizedDomain] = nextItems;
  saveProfile(profile);
}

export function addHardLimit(limit: string): void {
  const normalized = limit.trim();
  if (!normalized) return;
  const profile = loadProfile();
  if (!profile.hard_limits.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    profile.hard_limits.push(normalized);
    saveProfile(profile);
  }
}

export function addSoftLimit(item: string, conditions: string): void {
  const normalizedItem = item.trim();
  const normalizedConditions = conditions.trim();
  if (!normalizedItem) return;
  const profile = loadProfile();
  if (
    !profile.soft_limits.some(
      (entry) =>
        entry.item.toLowerCase() === normalizedItem.toLowerCase() &&
        entry.conditions.toLowerCase() === normalizedConditions.toLowerCase()
    )
  ) {
    profile.soft_limits.push({ item: normalizedItem, conditions: normalizedConditions });
    saveProfile(profile);
  }
}

export function getProfileSummary(): string {
  const profile = loadProfile();
  const role = profile.role_identity || "unmapped";
  const coreDesires = profile.core_desires.length > 0 ? profile.core_desires.slice(0, 3).join("+") : "unmapped";
  const hardLimits = profile.hard_limits.length > 0 ? profile.hard_limits.slice(0, 4).join(",") : "none mapped";
  const topKinks = flattenTopKinks(profile)
    .slice(0, 3)
    .map((entry) => `${entry.label}(${entry.rating})`)
    .join(", ");

  return `[Profilul lui Pafi: role=${role}, phase=${profile.training_phase}, core desires=${coreDesires}, hard limits=${hardLimits}, top kinks=${topKinks || "none mapped"}]`;
}

export function advancePhase(): void {
  const profile = loadProfile();
  profile.training_phase = Math.min(8, (Number(profile.training_phase) || 0) + 1);
  saveProfile(profile);
}
