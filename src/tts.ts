/**
 * Text-to-Speech module using Microsoft Edge TTS (free, no API key)
 * Supports Romanian (ro-RO) and English (en-US) voices
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { unlink, mkdir } from "fs/promises";
import { join } from "path";

const TEMP_DIR = join(process.env.HOME || "~", ".claude-relay/tts");

// Voice selection based on language detection
const VOICES = {
  ro: "ro-RO-EmilNeural",    // Romanian male
  en: "en-US-GuyNeural",     // English male
};

// Simple Romanian detection
function detectLanguage(text: string): "ro" | "en" {
  const roWords = /\b(și|este|sunt|care|pentru|din|sau|dar|cum|unde|când|poate|trebuie|foarte|bine|mulțumesc|salut|bună|nu|da|ce|în|la|pe|cu|de|mai|așa|asta|aici|acum|doar|deja|încă|despre|după|între|prin|fără|către|până|sub|peste|dintre|totul|nimic|fiecare|astfel|totuși|deoarece|deși|dacă|ori|fie|nici|atât|câți|cât)\b/i;
  const matches = text.match(roWords);
  return matches && matches.length >= 2 ? "ro" : "en";
}

/**
 * Clean text for TTS (remove markdown, code, URLs)
 */
function cleanForTTS(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " cod omis ")    // code blocks
    .replace(/`[^`]+`/g, "")                      // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")      // markdown links
    .replace(/[*_~#>|]/g, "")                      // markdown formatting
    .replace(/https?:\/\/\S+/g, "")               // URLs
    .replace(/\n{2,}/g, ". ")                      // double newlines to pause
    .replace(/\n/g, " ")                           // single newlines
    .replace(/\s{2,}/g, " ")                       // multiple spaces
    .trim();
}

/**
 * Convert text to speech and return the file path
 */
export async function textToSpeech(text: string): Promise<string | null> {
  try {
    const cleanText = cleanForTTS(text);

    // Skip TTS for very short or empty text
    if (cleanText.length < 3) return null;

    // Truncate very long responses
    const truncated = cleanText.length > 3000
      ? cleanText.substring(0, 3000) + "... restul în text."
      : cleanText;

    // Each call gets its own temp directory (toFile creates audio.mp3 inside it)
    const timestamp = Date.now();
    const outDir = join(TEMP_DIR, `${timestamp}`);
    await mkdir(outDir, { recursive: true });

    const lang = detectLanguage(text);
    const voice = VOICES[lang];

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const result = await tts.toFile(outDir, truncated);
    return result.audioFilePath;
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

/**
 * Clean up TTS temp file and directory
 */
export async function cleanupTTS(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    // Also remove the temp directory
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    const { rmdir } = await import("fs/promises");
    await rmdir(dir).catch(() => {});
  } catch {}
}
