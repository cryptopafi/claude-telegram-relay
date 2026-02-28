#!/usr/bin/env bun
/**
 * morning-reports.ts — Daily 06:00 briefing via @claudemacm4_bot
 * Sends 2 reports: Business + Personal
 */
import { Bot } from "grammy";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "623593648";
const CORTEX_URL = process.env.CORTEX_URL || "http://100.81.233.9:6400";

const BUSINESS_PROJECTS = [
  { name: "AI-B2B Agency", collection: "business_ai_b2b" },
  { name: "Clickwin.vip", collection: "business_clickwin" },
  { name: "Solnest.ai", collection: "business_solnest" },
  { name: "Business Intelligence", collection: "intelligence" },
];

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchCortexUpdates(collection: string, limit = 3): Promise<string[]> {
  try {
    const res = await fetch(`${CORTEX_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "update progress status",
        collection,
        limit,
        filter: { since_hours: 24 },
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<{ text?: string }> };
    return (data.results || []).map((r) => r.text?.slice(0, 100) || "").filter(Boolean);
  } catch {
    return [];
  }
}

async function buildBusinessReport(): Promise<string> {
  const sections: string[] = [`*Business Report — ${isoDate()}*`, ""];
  for (const proj of BUSINESS_PROJECTS) {
    const updates = await fetchCortexUpdates(proj.collection);
    sections.push(`*${proj.name}*`);
    if (updates.length === 0) {
      sections.push("- No updates in last 24h");
    } else {
      updates.forEach((u) => sections.push(`- ${u}`));
    }
    sections.push("");
  }
  return sections.join("\n");
}

async function main() {
  if (!TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not set");
    process.exit(1);
  }
  const bot = new Bot(TOKEN);

  const businessReport = await buildBusinessReport();
  const personalReport = "*Personal*\n- No personal topics configured yet.";

  await bot.api.sendMessage(CHAT_ID, businessReport, { parse_mode: "Markdown" });
  await bot.api.sendMessage(CHAT_ID, personalReport, { parse_mode: "Markdown" });

  console.log("[MORNING REPORTS] Sent successfully at", new Date().toISOString());
  process.exit(0);
}

main().catch((e) => {
  console.error("[MORNING REPORTS ERROR]", e);
  process.exit(1);
});
