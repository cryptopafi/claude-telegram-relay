/**
 * Text-to-Speech module using Google Cloud TTS (Chirp3-HD voices)
 * Supports Romanian (ro-RO) and English (en-US)
 * Free tier: 1M chars/month (WaveNet/Chirp3-HD)
 */

import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";

const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || "";
const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const TEMP_DIR = join(process.env.HOME || "~", ".claude-relay/tts");

// Chirp3-HD voices (highest quality, same name works for both languages)
const VOICES = {
  ro: { name: "ro-RO-Chirp3-HD-Aoede", languageCode: "ro-RO" },
  en: { name: "en-US-Chirp3-HD-Aoede", languageCode: "en-US" },
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
 * Convert text to speech using Google Cloud TTS and return the file path
 */
export async function textToSpeech(text: string): Promise<string | null> {
  if (!GOOGLE_TTS_API_KEY) {
    console.error("GOOGLE_TTS_API_KEY not set");
    return null;
  }

  try {
    const cleanText = cleanForTTS(text);

    // Skip TTS for very short or empty text
    if (cleanText.length < 3) return null;

    // Truncate very long responses (save API quota)
    const truncated = cleanText.length > 3000
      ? cleanText.substring(0, 3000) + "... restul în text."
      : cleanText;

    const lang = detectLanguage(text);
    const voice = VOICES[lang];

    const response = await fetch(`${GOOGLE_TTS_URL}?key=${GOOGLE_TTS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: truncated },
        voice: {
          languageCode: voice.languageCode,
          name: voice.name,
        },
        audioConfig: {
          audioEncoding: "OGG_OPUS",
          sampleRateHertz: 24000,
          speakingRate: 1.0,
          pitch: 0.0,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Google TTS error:", response.status, err);
      return null;
    }

    const data = await response.json() as { audioContent: string };

    // Decode base64 audio and save to file
    const audioBuffer = Buffer.from(data.audioContent, "base64");
    const timestamp = Date.now();
    const outDir = join(TEMP_DIR, `${timestamp}`);
    await mkdir(outDir, { recursive: true });

    const audioPath = join(outDir, "audio.ogg");
    await writeFile(audioPath, audioBuffer);

    return audioPath;
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
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    const { rmdir } = await import("fs/promises");
    await rmdir(dir).catch(() => {});
  } catch {}
}
