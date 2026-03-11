import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface LunaMoodState {
  valence: number;
  arousal: number;
  dominance: number;
  cause: string;
  lastUpdated: number;
}

export interface LunaRelationshipState {
  affection: number;
  trust: number;
  intimacy: number;
  comfort: number;
  respect: number;
  stage: "stranger" | "acquaintance" | "friend" | "close" | "intimate";
}

export type LunaInteractionType = "casual" | "boundary" | "vulnerable" | "playful" | "affirming";

interface LunaStateFile {
  mood: LunaMoodState;
  relationship: LunaRelationshipState;
}

function getRelayDir(): string {
  return process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
}

function getStatePath(): string {
  return process.env.LUNA_STATE_PATH || join(getRelayDir(), "luna-state.json");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function timeOfDayProfile(timestamp = nowSeconds()): {
  label: string;
  mood: Pick<LunaMoodState, "valence" | "arousal" | "dominance">;
} {
  const hour = new Date(timestamp * 1000).getHours();
  if (hour >= 6 && hour < 12) {
    return {
      label: "dimineață precisă și tăioasă",
      mood: { valence: 0.1, arousal: 0.35, dominance: 0.88 },
    };
  }
  if (hour >= 12 && hour < 18) {
    return {
      label: "după-amiază energică",
      mood: { valence: 0.18, arousal: 0.58, dominance: 0.86 },
    };
  }
  if (hour >= 18 && hour < 24) {
    return {
      label: "seară intensă și probing",
      mood: { valence: 0.12, arousal: 0.78, dominance: 0.92 },
    };
  }
  return {
    label: "noapte mai adâncă și liniștită",
    mood: { valence: 0.05, arousal: 0.46, dominance: 0.9 },
  };
}

function defaultState(timestamp = nowSeconds()): LunaStateFile {
  const baseline = timeOfDayProfile(timestamp);
  return {
    mood: {
      ...baseline.mood,
      cause: baseline.label,
      lastUpdated: timestamp,
    },
    relationship: {
      affection: 0.18,
      trust: 0.18,
      intimacy: 0.12,
      comfort: 0.16,
      respect: 0.24,
      stage: "stranger",
    },
  };
}

function readState(): LunaStateFile {
  const path = getStatePath();
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LunaStateFile;
  } catch {
    const state = defaultState();
    writeState(state);
    return state;
  }
}

function writeState(state: LunaStateFile): void {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, path);
}

function applyDecay(current: number, baseline: number, hoursElapsed: number, min: number, max: number): number {
  const decay = clamp(hoursElapsed * 0.05, 0, 1);
  return clamp(current + (baseline - current) * decay, min, max);
}

function formatPause(hoursElapsed: number): string {
  if (hoursElapsed < 1) return "pauză scurtă";
  if (hoursElapsed < 24) return `pauză de ${Math.round(hoursElapsed)}h`;
  const days = Math.round(hoursElapsed / 24);
  return `pauză de ${days}z`;
}

function moodDescriptor(state: LunaMoodState): string {
  if (state.arousal >= 0.72 && state.dominance >= 0.85) return "intensă și perfect în control";
  if (state.arousal >= 0.55 && state.dominance >= 0.8) return "alertă și precisă";
  if (state.arousal <= 0.35) return "relaxată, dar atentă";
  if (state.valence < -0.15) return "rece și iritată";
  return "controlată și observatoare";
}

function updateStage(relationship: LunaRelationshipState): LunaRelationshipState["stage"] {
  const score =
    (relationship.affection +
      relationship.trust +
      relationship.intimacy +
      relationship.comfort +
      relationship.respect) /
    5;
  if (score >= 0.75) return "intimate";
  if (score >= 0.58) return "close";
  if (score >= 0.42) return "friend";
  if (score >= 0.26) return "acquaintance";
  return "stranger";
}

export function getMoodState(): LunaMoodState {
  const state = readState();
  const timestamp = nowSeconds();
  const baseline = timeOfDayProfile(timestamp);
  const hoursElapsed = Math.max(0, (timestamp - Number(state.mood.lastUpdated || timestamp)) / 3600);
  return {
    valence: round2(applyDecay(Number(state.mood.valence || 0), baseline.mood.valence, hoursElapsed, -1, 1)),
    arousal: round2(applyDecay(Number(state.mood.arousal || 0), baseline.mood.arousal, hoursElapsed, 0, 1)),
    dominance: round2(
      applyDecay(Number(state.mood.dominance || 0), baseline.mood.dominance, hoursElapsed, 0, 1)
    ),
    cause:
      hoursElapsed >= 1
        ? `${baseline.label}, conversație nouă după ${formatPause(hoursElapsed)}.`
        : state.mood.cause || baseline.label,
    lastUpdated: timestamp,
  };
}

export function updateMoodState(userMessage: string, lunaResponse: string): LunaMoodState {
  const state = readState();
  const timestamp = nowSeconds();
  const baseline = getMoodState();
  const combined = `${userMessage}\n${lunaResponse}`;

  const positiveHits = (combined.match(/\b(?:good|trust|safe|closer|warm|care|thanks|thank you|bine|mulțumesc|incredere|sigur|calm|aproape)\b/giu) || []).length;
  const conflictHits = (combined.match(/\b(?:no|stop|angry|upset|fight|conflict|wrong|fear|afraid|nu|stop|greșit|frică|rău|furios)\b/giu) || []).length;
  const excitementHits =
    (combined.match(/[!?]{2,}/g) || []).length +
    (combined.match(/\b(?:excited|need|want|now|harder|please|vreau|acum|mai|te rog|intens)\b/giu) || []).length;
  const certaintyHits = (lunaResponse.match(/\b(?:good pet|breathe|say it clearly|noted|understood|clar|notat|respiră)\b/giu) || []).length;

  const deltaValence = clamp(positiveHits * 0.05 - conflictHits * 0.08, -0.2, 0.2);
  const deltaArousal = clamp(excitementHits * 0.04 - conflictHits * 0.03, -0.2, 0.2);
  const deltaDominance = clamp(certaintyHits * 0.04 - conflictHits * 0.07, -0.2, 0.2);

  const nextMood: LunaMoodState = {
    valence: round2(clamp(baseline.valence + deltaValence, -1, 1)),
    arousal: round2(clamp(baseline.arousal + deltaArousal, 0, 1)),
    dominance: round2(clamp(baseline.dominance + deltaDominance, 0, 1)),
    cause:
      conflictHits > positiveHits
        ? "fricțiune sau rezistență detectată."
        : excitementHits > 0
          ? "energie în creștere în conversație."
          : positiveHits > 0
            ? "deschidere și cooperare constantă."
            : timeOfDayProfile(timestamp).label,
    lastUpdated: timestamp,
  };

  writeState({ ...state, mood: nextMood });
  return nextMood;
}

export function getRelationshipState(): LunaRelationshipState {
  const state = readState();
  return {
    ...state.relationship,
    stage: updateStage(state.relationship),
  };
}

export function updateRelationshipState(interactionType: LunaInteractionType): LunaRelationshipState {
  const state = readState();
  const relationship = { ...state.relationship };
  const adjustments: Record<LunaInteractionType, Partial<LunaRelationshipState>> = {
    casual: { affection: 0.01, comfort: 0.01, respect: 0.01 },
    boundary: { trust: 0.03, respect: 0.02, comfort: 0.01 },
    vulnerable: { trust: 0.04, intimacy: 0.03, affection: 0.02, comfort: 0.02 },
    playful: { affection: 0.02, intimacy: 0.02, comfort: 0.01 },
    affirming: { trust: 0.02, respect: 0.02, affection: 0.01, intimacy: 0.01 },
  };

  for (const [key, value] of Object.entries(adjustments[interactionType])) {
    const metric = key as keyof Omit<LunaRelationshipState, "stage">;
    relationship[metric] = round2(clamp(Number(relationship[metric]) + Number(value), 0, 1));
  }

  relationship.stage = updateStage(relationship);
  writeState({ ...state, relationship });
  return relationship;
}

export function getMoodBlock(): string {
  const mood = getMoodState();
  return `[Starea ta actuală: ${moodDescriptor(mood)}. Cauza: ${mood.cause}]`;
}
