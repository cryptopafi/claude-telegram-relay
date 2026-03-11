import { homedir } from "os";
import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { isEnabled } from "../feature-flags";

const HOME = homedir();
const TZ = "Europe/Bucharest";
const RELAY_ENV_PATH = join(HOME, "repos", "godagoo", "claude-telegram-relay", ".env");
const CODEX_LOG_PATH = join(HOME, ".codex", "codex-to-genie.md");
const SESSION_LIVE_PATH = join(HOME, ".nexus", "workspace", "intel", "SESSION-LIVE.md");
const TASKS_PATH = join(HOME, ".claude", "projects", "-Users-pafi", "memory", "tasks", "pafi-tasks.md");
const TELEGRAM_LOG_PATH = join(HOME, ".claude", "projects", "-Users-pafi", "memory", "telegram-log.md");
const STATE_PATH = join(HOME, ".nexus", "inbox", "smart-checkin-state.json");
const MORNING_BRIEF_PATH = join(HOME, ".nexus", "scripts", "morning-brief.py");

const RATE_LIMIT_MS = 30 * 60 * 1000;
const USER_COOLDOWN_MS = 15 * 60 * 1000;
const QUIET_START_HOUR = 2;
const QUIET_END_HOUR = 8;
const MAX_TELEGRAM_MESSAGE_CHARS = 3900;

interface SmartCheckinState {
  codexOffset: number;
  lastSentAt: number;
  pendingCodexDone: string[];
}

interface CalendarEvent {
  title: string;
  startLocal: Date;
}

function loadRelayEnv(path = RELAY_ENV_PATH): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatZonedParts(date: Date = new Date()): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const out: Record<string, number> = {};
  for (const part of parts) {
    if (["year", "month", "day", "hour", "minute"].includes(part.type)) {
      out[part.type] = Number(part.value);
    }
  }
  return out;
}

function todayIsoInBucharest(now = new Date()): string {
  const parts = formatZonedParts(now);
  const month = String(parts.month || 1).padStart(2, "0");
  const day = String(parts.day || 1).padStart(2, "0");
  return `${parts.year || 1970}-${month}-${day}`;
}

export function isQuietHoursHour(hour: number): boolean {
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

function isQuietHours(now = new Date()): boolean {
  const hour = formatZonedParts(now).hour ?? 0;
  return isQuietHoursHour(hour);
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function loadState(): SmartCheckinState {
  if (!existsSync(STATE_PATH)) {
    return { codexOffset: 0, lastSentAt: 0, pendingCodexDone: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return {
      codexOffset: Number(parsed.codexOffset || 0),
      lastSentAt: Number(parsed.lastSentAt || 0),
      pendingCodexDone: Array.isArray(parsed.pendingCodexDone)
        ? parsed.pendingCodexDone.map((x: unknown) => String(x)).slice(-8)
        : [],
    };
  } catch {
    return { codexOffset: 0, lastSentAt: 0, pendingCodexDone: [] };
  }
}

function saveState(state: SmartCheckinState): void {
  ensureParentDir(STATE_PATH);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function extractDoneLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\bDONE\b/i.test(line));
}

function readNewCodexDone(offset: number): { nextOffset: number; doneLines: string[] } {
  if (!existsSync(CODEX_LOG_PATH)) return { nextOffset: offset, doneLines: [] };
  const content = readFileSync(CODEX_LOG_PATH, "utf-8");
  const safeOffset = Math.min(Math.max(offset, 0), Buffer.byteLength(content, "utf-8"));
  const chunk = Buffer.from(content, "utf-8").slice(safeOffset).toString("utf-8");
  const nextOffset = Buffer.byteLength(content, "utf-8");
  return { nextOffset, doneLines: extractDoneLines(chunk).slice(-4) };
}

function readSentinelSignal(): string | null {
  if (!existsSync(SESSION_LIVE_PATH)) return null;
  const lines = readFileSync(SESSION_LIVE_PATH, "utf-8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\bCRITICAL\b/i.test(line)) {
      return `SENTINEL <b>CRITICAL</b>: ${htmlEscape(line).slice(0, 180)}`;
    }
    if (/\bHIGH\b/i.test(line)) {
      return `SENTINEL <b>HIGH</b>: ${htmlEscape(line).slice(0, 180)}`;
    }
  }
  return null;
}

function fetchCalendarEvents(): CalendarEvent[] {
  if (!existsSync(MORNING_BRIEF_PATH)) return [];
  const pyCode = [
    "import json, importlib.util",
    "from datetime import datetime",
    "from pathlib import Path",
    `path = Path(${JSON.stringify(MORNING_BRIEF_PATH)})`,
    "spec = importlib.util.spec_from_file_location('morning_brief_mod', str(path))",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "today = datetime.now().astimezone().date()",
    "data = mod.fetch_calendar_today(today)",
    "items = []",
    "for it in data.get('items', []):",
    "  items.append({'title': str(getattr(it, 'title', '')), 'start_local': getattr(it, 'start_local').isoformat()})",
    "print(json.dumps({'items': items}, ensure_ascii=False))",
  ].join("\n");

  const result = spawnSync("python3", ["-c", pyCode], {
    encoding: "utf-8",
    timeout: 25_000,
  });

  if (result.status !== 0 || !result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout) as { items?: Array<{ title?: string; start_local?: string }> };
    return (parsed.items || [])
      .map((item) => ({
        title: String(item.title || "").trim() || "(no title)",
        startLocal: new Date(String(item.start_local || "")),
      }))
      .filter((event) => !Number.isNaN(event.startLocal.getTime()))
      .sort((a, b) => a.startLocal.getTime() - b.startLocal.getTime());
  } catch {
    return [];
  }
}

function nextEventWithin30Min(now = new Date()): string | null {
  const windowEnd = now.getTime() + 30 * 60 * 1000;
  for (const event of fetchCalendarEvents()) {
    const start = event.startLocal.getTime();
    if (start < now.getTime()) continue;
    if (start > windowEnd) break;
    const hhmm = event.startLocal.toLocaleTimeString("ro-RO", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: TZ,
    });
    return `Calendar: ${hhmm} ${htmlEscape(event.title).slice(0, 120)}`;
  }
  return null;
}

export function parseOverdueTasksFromContent(content: string, todayIso: string): { count: number; samples: string[] } {
  const samples: string[] = [];
  let count = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    if (!/^-\s*\[\s\]/.test(rawLine)) continue;
    const dueMatch = rawLine.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (!dueMatch) continue;
    const due = dueMatch[1];
    if (due >= todayIso) continue;
    count += 1;
    if (samples.length < 3) {
      const title = rawLine
        .replace(/^-\s*\[\s\]\s*/, "")
        .replace(/\s*📅\s*20\d{2}-\d{2}-\d{2}.*/, "")
        .trim();
      samples.push(`${title.slice(0, 90)} (${due})`);
    }
  }

  return { count, samples };
}

function readOverdueSignal(now = new Date()): string | null {
  if (!existsSync(TASKS_PATH)) return null;
  const todayIso = todayIsoInBucharest(now);
  const content = readFileSync(TASKS_PATH, "utf-8");
  const overdue = parseOverdueTasksFromContent(content, todayIso);
  if (overdue.count === 0) return null;
  const first = overdue.samples[0] ? ` e.g. ${htmlEscape(overdue.samples[0])}` : "";
  return `Tasks overdue: <b>${overdue.count}</b>${first}`;
}

function parseLastUserMessageMs(): number {
  if (!existsSync(TELEGRAM_LOG_PATH)) return 0;
  const content = readFileSync(TELEGRAM_LOG_PATH, "utf-8");
  const re = /^##\s+(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})\s+[—-]\s+User\s*$/gm;
  let last = 0;
  for (const match of content.matchAll(re)) {
    const [, mm, dd, yyyy, hh, min] = match;
    const ts = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0).getTime();
    if (!Number.isNaN(ts)) {
      last = Math.max(last, ts);
    }
  }
  return last;
}

function sendTelegramMessage(token: string, chatId: string, message: string): boolean {
  const payload = message.slice(0, MAX_TELEGRAM_MESSAGE_CHARS);
  const result = spawnSync(
    "curl",
    [
      "-s",
      `https://api.telegram.org/bot${token}/sendMessage`,
      "-d",
      `chat_id=${chatId}`,
      "--data-urlencode",
      `text=${payload}`,
      "-d",
      "parse_mode=HTML",
    ],
    { encoding: "utf-8", timeout: 15_000 }
  );
  if (result.status !== 0) return false;
  return /"ok"\s*:\s*true/.test(result.stdout);
}

function uniqueTail(lines: string[], max = 8): string[] {
  return Array.from(new Set(lines.map((x) => x.trim()).filter(Boolean))).slice(-max);
}

function runSmartCheckin(): number {
  loadRelayEnv();
  if (!isEnabled("FEATURE_PROACTIVE")) {
    console.log("[PROACTIVE] smart-checkin skipped: FEATURE_PROACTIVE disabled");
    return 0;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID || "623593648";
  if (!token || !chatId) {
    console.error("[PROACTIVE] smart-checkin missing Telegram credentials");
    return 1;
  }

  const state = loadState();
  const codexDelta = readNewCodexDone(state.codexOffset);
  state.codexOffset = codexDelta.nextOffset;
  state.pendingCodexDone = uniqueTail([...state.pendingCodexDone, ...codexDelta.doneLines], 8);

  const signals: string[] = [];
  if (state.pendingCodexDone.length > 0) {
    const latest = htmlEscape(state.pendingCodexDone[state.pendingCodexDone.length - 1]).slice(0, 180);
    signals.push(`Codex deliveries: <b>${state.pendingCodexDone.length}</b> pending (${latest})`);
  }

  const sentinel = readSentinelSignal();
  if (sentinel) signals.push(sentinel);

  const calendar = nextEventWithin30Min();
  if (calendar) signals.push(calendar);

  const overdue = readOverdueSignal();
  if (overdue) signals.push(overdue);

  if (signals.length === 0) {
    saveState(state);
    console.log("[PROACTIVE] smart-checkin: no active signals");
    return 0;
  }

  if (isQuietHours()) {
    saveState(state);
    console.log("[PROACTIVE] smart-checkin skipped: quiet hours");
    return 0;
  }

  const now = Date.now();
  if (state.lastSentAt > 0 && now - state.lastSentAt < RATE_LIMIT_MS) {
    saveState(state);
    console.log("[PROACTIVE] smart-checkin skipped: 30m rate limit");
    return 0;
  }

  const lastUserMessageAt = parseLastUserMessageMs();
  if (lastUserMessageAt > 0 && now - lastUserMessageAt < USER_COOLDOWN_MS) {
    saveState(state);
    console.log("[PROACTIVE] smart-checkin skipped: recent Pafi message");
    return 0;
  }

  const message = [`<b>Lis proactive check-in</b>`, ...signals.map((x) => `• ${x}`)].join("\n");
  const sent = sendTelegramMessage(token, chatId, message);

  if (sent) {
    state.lastSentAt = now;
    state.pendingCodexDone = [];
    console.log("[PROACTIVE] smart-checkin sent");
  } else {
    console.error("[PROACTIVE] smart-checkin send failed");
  }

  saveState(state);
  return sent ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = runSmartCheckin();
}
