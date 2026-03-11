import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { isEnabled } from "../feature-flags";

const HOME = homedir();
const RELAY_ENV_PATH = join(HOME, "repos", "godagoo", "claude-telegram-relay", ".env");
const CODEX_LOG_PATH = join(HOME, ".codex", "codex-to-genie.md");
const SESSION_LIVE_PATH = join(HOME, ".nexus", "workspace", "intel", "SESSION-LIVE.md");
const TASKS_PATH = join(HOME, ".claude", "projects", "-Users-pafi", "memory", "tasks", "pafi-tasks.md");
const CHAT_ID = "623593648";

function loadEnvVar(key: string): string {
  try {
    const envContent = readFileSync(RELAY_ENV_PATH, "utf-8");
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function safeRead(path: string, maxChars = 2000): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function countCodexOvernight(): number {
  const content = safeRead(CODEX_LOG_PATH, 50000);
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const donePattern = /\[(\d{4}-\d{2}-\d{2})\].*DONE/g;
  let count = 0;
  let match;
  while ((match = donePattern.exec(content)) !== null) {
    if (match[1] === today || match[1] === yesterday) count++;
  }
  return count;
}

function getHealthStatus(): string {
  const content = safeRead(SESSION_LIVE_PATH, 500);
  if (!content) return "unknown";
  if (/CRITICAL/i.test(content)) return "CRITICAL";
  if (/HIGH/i.test(content)) return "degraded";
  return "healthy";
}

function countPendingTasks(): number {
  const content = safeRead(TASKS_PATH, 10000);
  return (content.match(/- \[ \]/g) || []).length;
}

function buildBriefing(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", weekday: "long", day: "numeric", month: "long" });

  const codexCount = countCodexOvernight();
  const health = getHealthStatus();
  const pendingTasks = countPendingTasks();

  const lines: string[] = [];
  lines.push(`<b>Good morning, Pafi!</b>`);
  lines.push(`${dateStr}\n`);

  if (codexCount > 0) {
    lines.push(`Codex: ${codexCount} deliveries overnight`);
  }

  lines.push(`System: ${health}`);

  if (pendingTasks > 0) {
    lines.push(`Tasks: ${pendingTasks} pending`);
  }

  return lines.join("\n").slice(0, 500);
}

async function sendTelegram(text: string): Promise<void> {
  const botToken = loadEnvVar("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    console.error("[MORNING] No bot token found");
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });

  if (!response.ok) {
    console.error("[MORNING] Telegram send failed:", response.status);
  }
}

async function main(): Promise<void> {
  if (!isEnabled("FEATURE_PROACTIVE")) {
    console.log("[MORNING] FEATURE_PROACTIVE disabled, skipping");
    return;
  }

  const briefing = buildBriefing();
  await sendTelegram(briefing);
  console.log("[MORNING] Briefing sent");
}

main().catch((err) => {
  console.error("[MORNING] Fatal error:", err);
  process.exit(1);
});
