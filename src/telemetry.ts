import { appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

const TELEMETRY_PATH = process.env.RELAY_TELEMETRY_PATH ||
  join(homedir(), ".nexus", "logs", "relay-telemetry.jsonl");

const BUILD_PROMPT_BUDGET_MS = 200;
const FACT_CHECK_BUDGET_MS = 10_000;
const TOTAL_BUDGET_MS = 45_000;

interface TraceState {
  startedAtMs: number;
}

interface TelemetryEntry {
  timestamp: string;
  user_id: string;
  message_type: string;
  latency_ms: number;
  tokens_used: number;
  model: string;
  features_active: string[];
  error: string | null;
  build_prompt_ms?: number;
  fact_check_ms?: number;
}

export interface TraceResultInput {
  userId: string;
  messageType: string;
  tokensUsed?: number;
  model?: string;
  featuresActive?: string[];
  error?: string | null;
  buildPromptMs?: number;
  factCheckMs?: number;
}

const traces = new Map<string, TraceState>();

export function startTrace(messageId: string | number): void {
  traces.set(String(messageId), { startedAtMs: Date.now() });
}

function warnBudget(messageId: string, step: string, valueMs: number, budgetMs: number): void {
  if (valueMs > budgetMs) {
    console.warn(
      `[TELEMETRY] ${step} latency budget exceeded for ${messageId}: ${valueMs}ms > ${budgetMs}ms`
    );
  }
}

async function appendJsonLine(payload: object): Promise<void> {
  await mkdir(dirname(TELEMETRY_PATH), { recursive: true });
  await appendFile(TELEMETRY_PATH, `${JSON.stringify(payload)}\n`, "utf-8");
}

export async function endTrace(
  messageId: string | number,
  result: TraceResultInput
): Promise<void> {
  const id = String(messageId);
  const trace = traces.get(id);
  const now = Date.now();
  const latency = Math.max(0, now - (trace?.startedAtMs ?? now));
  traces.delete(id);

  const entry: TelemetryEntry = {
    timestamp: new Date(now).toISOString(),
    user_id: result.userId || "unknown",
    message_type: result.messageType || "unknown",
    latency_ms: latency,
    tokens_used: Math.max(0, Math.floor(result.tokensUsed ?? 0)),
    model: result.model || "unknown",
    features_active: result.featuresActive ?? [],
    error: result.error ?? null,
    build_prompt_ms: result.buildPromptMs,
    fact_check_ms: result.factCheckMs,
  };

  warnBudget(id, "buildPrompt", result.buildPromptMs ?? 0, BUILD_PROMPT_BUDGET_MS);
  warnBudget(id, "factCheck", result.factCheckMs ?? 0, FACT_CHECK_BUDGET_MS);
  warnBudget(id, "total", latency, TOTAL_BUDGET_MS);

  await appendJsonLine(entry);
}

export async function getLatencyStats(last_n: number): Promise<{
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}> {
  const file = Bun.file(TELEMETRY_PATH);
  if (!(await file.exists())) {
    return { count: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  }

  const text = await file.text();
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-Math.max(1, last_n));
  const latencies: number[] = [];

  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Partial<TelemetryEntry>;
      const value = Number(parsed.latency_ms);
      if (Number.isFinite(value)) {
        latencies.push(value);
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (latencies.length === 0) {
    return { count: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 };
  }

  latencies.sort((a, b) => a - b);
  const count = latencies.length;
  const sum = latencies.reduce((acc, value) => acc + value, 0);
  const pick = (pct: number): number => latencies[Math.min(count - 1, Math.floor((count - 1) * pct))];

  return {
    count,
    avg_ms: Math.round((sum / count) * 100) / 100,
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    max_ms: latencies[count - 1],
  };
}
