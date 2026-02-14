/**
 * File-based conversation logger
 *
 * Appends Telegram conversations to a markdown file in the synced memory directory.
 * This file is auto-synced via git to all machines (MacM4, MacIntel, VPS),
 * so Claude Code sessions on any machine can see recent Telegram context.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const LOG_PATH =
  process.env.TELEGRAM_LOG_PATH ||
  `${process.env.HOME}/.claude/projects/-Users-pafi/memory/telegram-log.md`;

const MAX_ENTRIES = 100;
const HEADER = "# Telegram Conversations\n";
const SEPARATOR = "\n---\n";

export async function appendToLog(
  role: "user" | "assistant",
  content: string
): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });

    let existing = "";
    try {
      existing = await readFile(LOG_PATH, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const now = new Date();
    const timestamp = now.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const label = role === "user" ? "User" : "Assistant";
    const entry = `## ${timestamp} — ${label}\n${content}\n`;

    if (!existing) {
      await writeFile(LOG_PATH, HEADER + "\n" + entry + SEPARATOR);
    } else {
      await writeFile(LOG_PATH, existing.trimEnd() + "\n\n" + entry + SEPARATOR);
    }

    await trimLog();
  } catch (error) {
    console.error("File logger error:", error);
  }
}

async function trimLog(): Promise<void> {
  try {
    const content = await readFile(LOG_PATH, "utf-8");

    // Split on the ## heading pattern to find entries
    const entries = content.split(/(?=^## \d)/m);

    // First element is the header (before any ## date entry)
    const header = entries[0];
    const messages = entries.slice(1);

    if (messages.length <= MAX_ENTRIES) return;

    // Keep only the last MAX_ENTRIES messages
    const trimmed = header + messages.slice(-MAX_ENTRIES).join("");
    await writeFile(LOG_PATH, trimmed);
  } catch {
    // Ignore trim errors
  }
}
