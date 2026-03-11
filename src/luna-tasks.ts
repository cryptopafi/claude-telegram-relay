import { type PafiProfile, loadProfile, saveProfile } from "./luna-profile";
import { readTrainingAsset } from "./luna-training";

export interface LunaTask {
  id: string;
  level: "light" | "medium" | "deep" | "mental";
  category: "clothing" | "behavioral" | "sexual" | "humiliation" | "journal" | "fantasy";
  description: string;
  requires_physical: boolean;
}

export interface TaskResponse {
  date?: string;
  response: string;
  feeling: string;
}

interface ParsedLunaTask extends LunaTask {
  domains: string[];
  conflicts: string[];
}

const FALLBACK_TASKS: ParsedLunaTask[] = [
  {
    id: "journal-trigger-map",
    level: "mental",
    category: "journal",
    description: "Write a short check-in on what control, ownership, and surrender mean to you today.",
    requires_physical: false,
    domains: ["psychological", "ownership", "control"],
    conflicts: [],
  },
  {
    id: "clothing-anchor",
    level: "light",
    category: "clothing",
    description: "Choose one private ritual item for the evening and note how it changes your headspace.",
    requires_physical: true,
    domains: ["feminization", "ritual", "clothing"],
    conflicts: ["public exposure"],
  },
  {
    id: "behavioral-mirror",
    level: "medium",
    category: "behavioral",
    description: "Practice a short obedience ritual, then journal where resistance appeared and why.",
    requires_physical: false,
    domains: ["obedience", "behavioral", "psychological"],
    conflicts: [],
  },
  {
    id: "fantasy-boundary-audit",
    level: "mental",
    category: "fantasy",
    description: "Describe one fantasy scene in non-graphic terms, then separate what is fantasy-only from what feels negotiable.",
    requires_physical: false,
    domains: ["fantasy", "limits", "humiliation"],
    conflicts: [],
  },
  {
    id: "humiliation-script",
    level: "deep",
    category: "humiliation",
    description: "Draft a short humiliation script that stays inside negotiated language and note the lines that hit hardest.",
    requires_physical: false,
    domains: ["humiliation", "psychological", "trigger"],
    conflicts: ["verbal humiliation"],
  },
];

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function parseTaskLibrary(text: string | null): ParsedLunaTask[] {
  if (!text) return [];
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.includes("id:"));

  const tasks: ParsedLunaTask[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const match = line.match(/^([a-z_]+):\s*(.+)$/i);
      if (!match) continue;
      fields.set(match[1].toLowerCase(), match[2].trim());
    }

    const id = fields.get("id") || "";
    const level = fields.get("level") as ParsedLunaTask["level"] | undefined;
    const category = fields.get("category") as ParsedLunaTask["category"] | undefined;
    const description = fields.get("description") || "";

    if (!id || !level || !category || !description) continue;

    tasks.push({
      id,
      level,
      category,
      description,
      requires_physical: parseBoolean(fields.get("requires_physical") || "false"),
      domains: (fields.get("domains") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      conflicts: (fields.get("conflicts") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
  }

  return tasks;
}

function getTaskLibrary(): ParsedLunaTask[] {
  const parsed = parseTaskLibrary(readTrainingAsset("task-library.txt"));
  return parsed.length > 0 ? parsed : FALLBACK_TASKS;
}

function hasSufficientKinkData(profile: PafiProfile): boolean {
  let count = 0;
  for (const domain of Object.values(profile.kinks)) {
    count += Object.keys(domain).length;
  }
  return count >= 2;
}

function allowedLevels(profile: PafiProfile): Set<ParsedLunaTask["level"]> {
  if (profile.feminization.current_level === "deep") {
    return new Set(["light", "medium", "deep", "mental"]);
  }
  if (profile.feminization.current_level === "medium") {
    return new Set(["light", "medium", "mental"]);
  }
  return new Set(["light", "mental"]);
}

function conflictsWithHardLimits(task: ParsedLunaTask, profile: PafiProfile): boolean {
  const limits = profile.hard_limits.map((limit) => limit.toLowerCase());
  if (limits.length === 0) return false;

  const haystacks = [
    task.description.toLowerCase(),
    ...task.conflicts.map((value) => value.toLowerCase()),
    ...task.domains.map((value) => value.toLowerCase()),
  ];

  return limits.some((limit) => haystacks.some((haystack) => haystack.includes(limit)));
}

function taskWeight(task: ParsedLunaTask, profile: PafiProfile): number {
  let score = 1;
  for (const domain of task.domains) {
    const domainRatings = profile.kinks[domain] || profile.kinks[domain.toLowerCase()] || {};
    const values = Object.values(domainRatings).map((rating) => Number(rating) || 0);
    if (values.length > 0) {
      score += Math.max(...values);
      continue;
    }

    for (const [profileDomain, items] of Object.entries(profile.kinks)) {
      if (!profileDomain.toLowerCase().includes(domain.toLowerCase())) continue;
      const valuesForDomain = Object.values(items).map((rating) => Number(rating) || 0);
      if (valuesForDomain.length > 0) {
        score += Math.max(...valuesForDomain);
      }
    }
  }
  if (task.level === "mental") score += 0.5;
  if (!task.requires_physical) score += 0.25;
  return score;
}

export function getAvailableTasks(profile: PafiProfile): LunaTask[] {
  if (profile.feminization.program_status !== "active") return [];
  if ((Number(profile.training_phase) || 0) < 6) return [];
  if (!hasSufficientKinkData(profile)) return [];

  const permittedLevels = allowedLevels(profile);
  return getTaskLibrary()
    .filter((task) => permittedLevels.has(task.level))
    .filter((task) => !conflictsWithHardLimits(task, profile))
    .map(({ domains: _domains, conflicts: _conflicts, ...task }) => task);
}

export function selectTask(profile: PafiProfile, lastTaskId?: string): LunaTask {
  const parsed = getTaskLibrary()
    .filter((task) => allowedLevels(profile).has(task.level))
    .filter((task) => !conflictsWithHardLimits(task, profile));

  if (profile.feminization.program_status !== "active" || (Number(profile.training_phase) || 0) < 6) {
    throw new Error("Task assignment is not available for the current profile state");
  }

  if (!hasSufficientKinkData(profile)) {
    throw new Error("Not enough kink data to select a task");
  }

  const pool = parsed.filter((task) => task.id !== lastTaskId);
  const candidates = pool.length > 0 ? pool : parsed;
  if (candidates.length === 0) {
    throw new Error("No Luna tasks available");
  }

  const selected = [...candidates].sort((left, right) => {
    return taskWeight(right, profile) - taskWeight(left, profile) || left.id.localeCompare(right.id);
  })[0];

  const { domains: _domains, conflicts: _conflicts, ...task } = selected;
  return task;
}

export function logTaskCompletion(profile: PafiProfile, taskId: string, response: TaskResponse): void {
  const task = getTaskLibrary().find((entry) => entry.id === taskId);
  const nextProfile = profile || loadProfile();
  nextProfile.feminization.task_history.push({
    date: response.date || new Date().toISOString(),
    task: task?.description || taskId,
    response: response.response.trim(),
    feeling: response.feeling.trim(),
  });
  nextProfile.feminization.task_history = nextProfile.feminization.task_history.slice(-100);
  saveProfile(nextProfile);
}
