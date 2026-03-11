import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { isEnabled } from "../feature-flags";

const HOME = homedir();
const MEMORY_DB_PATH = join(HOME, ".nexus", "memory", "lis-memory.db");
const RELAY_ENV_PATH = join(HOME, "repos", "godagoo", "claude-telegram-relay", ".env");
const CHAT_ID = "623593648";

// Romanian + English commitment patterns
const COMMITMENT_RE = /\b(o\s+s[aă]\s+fac|m[aă]ine|p[aâ]n[aă]\s+(vineri|luni|mar[tț]i|miercuri|joi|s[aâ]mb[aă]t[aă]|duminic[aă])|remind\s+me|promit|voi\s+face|trebuie\s+s[aă]|must\s+do|will\s+do|i'll|gonna)\b/i;

const DONE_RE = /\b(done|gata|am\s+f[aă]cut|terminat|rezolvat|completed|finished)\b/i;

interface FollowUp {
  id: string;
  text: string;
  createdAt: string;
  deadline?: string;
  done: boolean;
}

function loadEnvVar(key: string): string {
  try {
    const envContent = readFileSync(RELAY_ENV_PATH, "utf-8");
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

export function detectCommitment(text: string): boolean {
  return COMMITMENT_RE.test(text);
}

export function detectDone(text: string): boolean {
  return DONE_RE.test(text);
}

export function extractDeadline(text: string): string | undefined {
  const tomorrow = /\b(m[aă]ine|tomorrow)\b/i;
  if (tomorrow.test(text)) {
    const d = new Date(Date.now() + 86400000);
    return d.toISOString().split("T")[0];
  }

  const dayMatch = text.match(/\bp[aâ]n[aă]\s+(vineri|luni|mar[tț]i|miercuri|joi|s[aâ]mb[aă]t[aă]|duminic[aă])/i);
  if (dayMatch) {
    const dayMap: Record<string, number> = {
      luni: 1, marti: 2, marți: 2, miercuri: 3, joi: 4,
      vineri: 5, sambata: 6, sâmbătă: 6, duminica: 0, duminică: 0,
    };
    const targetDay = dayMap[dayMatch[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
    if (targetDay !== undefined) {
      const now = new Date();
      let daysUntil = (targetDay - now.getDay() + 7) % 7;
      if (daysUntil === 0) daysUntil = 7;
      const target = new Date(now.getTime() + daysUntil * 86400000);
      return target.toISOString().split("T")[0];
    }
  }
  return undefined;
}

async function sendTelegram(text: string): Promise<void> {
  const botToken = loadEnvVar("TELEGRAM_BOT_TOKEN");
  if (!botToken) return;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  }).catch(() => {});
}

export async function checkOverdueFollowups(db: any): Promise<void> {
  if (!isEnabled("FEATURE_PROACTIVE")) return;

  try {
    const today = new Date().toISOString().split("T")[0];
    const rows = db
      .query("SELECT id, content, deadline FROM memories WHERE type = 'followup' AND deadline < ? AND content NOT LIKE '%[DONE]%' LIMIT 5")
      .all(today) as Array<{ id: number; content: string; deadline: string }>;

    if (rows.length === 0) return;

    const lines = rows.map(
      (r) => `- ${r.content.slice(0, 80)} (deadline: ${r.deadline})`
    );
    const msg = `<b>Follow-up reminder</b>\n\n${lines.join("\n")}\n\nReply "gata" to mark as done.`;
    await sendTelegram(msg);
  } catch (err) {
    console.error("[FOLLOWUP] Error checking overdue:", err);
  }
}
