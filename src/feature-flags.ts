const FLAG_NAMES = [
  "FEATURE_SMART_DISPATCH",
  "FEATURE_CONTEXT_OPTIMIZATION",
  "FEATURE_MEMORY_EVOLUTION",
  "FEATURE_PROACTIVE",
  "FEATURE_FACT_CHECK",
] as const;

type FlagName = typeof FLAG_NAMES[number];
type FlagState = Record<FlagName, boolean>;

const REFRESH_MS = 60_000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

function parseFlag(value?: string): boolean {
  if (!value) return false;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function readFlagsFromEnv(): FlagState {
  return {
    FEATURE_SMART_DISPATCH: parseFlag(process.env.FEATURE_SMART_DISPATCH),
    FEATURE_CONTEXT_OPTIMIZATION: parseFlag(process.env.FEATURE_CONTEXT_OPTIMIZATION),
    FEATURE_MEMORY_EVOLUTION: parseFlag(process.env.FEATURE_MEMORY_EVOLUTION),
    FEATURE_PROACTIVE: parseFlag(process.env.FEATURE_PROACTIVE),
    FEATURE_FACT_CHECK: parseFlag(process.env.FEATURE_FACT_CHECK),
  };
}

let cachedFlags: FlagState = readFlagsFromEnv();
let lastRefreshTs = Date.now();

function refreshFlags(): void {
  cachedFlags = readFlagsFromEnv();
  lastRefreshTs = Date.now();
}

const refreshTimer = setInterval(refreshFlags, REFRESH_MS);
if (typeof (refreshTimer as any).unref === "function") {
  (refreshTimer as any).unref();
}

function refreshIfStale(): void {
  if (Date.now() - lastRefreshTs >= REFRESH_MS) {
    refreshFlags();
  }
}

export function __refreshFlagsForTests(): void {
  refreshFlags();
}

export function isEnabled(flag: string): boolean {
  refreshIfStale();
  if (!FLAG_NAMES.includes(flag as FlagName)) {
    return false;
  }
  return cachedFlags[flag as FlagName];
}

export function getAllFlags(): Record<string, boolean> {
  refreshIfStale();
  return { ...cachedFlags };
}
