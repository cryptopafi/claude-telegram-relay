/**
 * Memory Sync Module
 *
 * Writes important notes from Telegram conversations back to the
 * shared git-synced memory, so Claude Code sessions can access them.
 */

import { readFile, writeFile, appendFile } from "fs/promises";
import { join } from "path";

const MEMORY_DIR = join(process.env.HOME || "~", ".claude/projects/-Users-pafi/memory");
const TELEGRAM_NOTES_FILE = join(MEMORY_DIR, "telegram-notes.md");
const MAX_NOTES = 50; // Keep last 50 notes

interface MemoryNote {
  timestamp: string;
  content: string;
}

/**
 * Save a note from Telegram to the shared memory repo.
 * Notes are appended to telegram-notes.md which auto-syncs via git.
 */
export async function saveToSharedMemory(content: string): Promise<boolean> {
  try {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const entry = `\n- **[${timestamp}]** ${content}\n`;

    // Check if file exists, create header if not
    let existing = "";
    try {
      existing = await readFile(TELEGRAM_NOTES_FILE, "utf-8");
    } catch {
      existing = "# Telegram Notes\nImportant notes from Telegram conversations (auto-synced).\n";
    }

    // Count existing notes and trim if too many
    const lines = existing.split("\n");
    const noteLines = lines.filter(l => l.startsWith("- **["));
    if (noteLines.length >= MAX_NOTES) {
      // Remove oldest notes (keep last MAX_NOTES - 10)
      const headerEnd = lines.findIndex(l => l.startsWith("- **["));
      const header = lines.slice(0, headerEnd).join("\n");
      const notes = lines.slice(headerEnd);
      const trimmedNotes = notes.slice(notes.length - (MAX_NOTES - 10));
      existing = header + "\n" + trimmedNotes.join("\n");
    }

    await writeFile(TELEGRAM_NOTES_FILE, existing + entry);
    console.log("Saved to shared memory:", content.substring(0, 50));
    return true;
  } catch (error) {
    console.error("Failed to save to shared memory:", error);
    return false;
  }
}

/**
 * Parse [SAVE: ...] tags from Claude's response.
 * These are explicit save-to-memory requests from the conversation.
 */
export function parseSaveTags(response: string): { cleaned: string; notes: string[] } {
  const notes: string[] = [];
  let cleaned = response;

  for (const match of response.matchAll(/\[SAVE:\s*(.+?)\]/gi)) {
    notes.push(match[1]);
    cleaned = cleaned.replace(match[0], "");
  }

  return { cleaned: cleaned.trim(), notes };
}
