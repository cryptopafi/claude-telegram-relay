/**
 * URL Handler Module
 * Detects URLs in messages, fetches content:
 * - YouTube links: extracts transcript/captions, falls back to audio transcription
 * - Other URLs: extracts article text via Readability
 */

import { getVideoDetails } from "youtube-caption-extractor";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { spawn } from "bun";
import { readFile, readdir, stat, unlink } from "fs/promises";
import { join } from "path";

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const YOUTUBE_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
const YT_DLP_ENV = process.env.YT_DLP_PATH;
const YT_DLP_CANDIDATES = [
  YT_DLP_ENV,
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
  "yt-dlp",
].filter(Boolean) as string[];
const TEMP_DIR = join(process.env.HOME || "~", ".claude-relay/temp");
const MAX_AUDIO_DURATION = 600; // 10 minutes max for transcription
const GROQ_KEYCHAIN_SERVICE = "groq-api-key";
const GROQ_KEYCHAIN_ACCOUNT = "pafi";

export interface ExtractedContent {
  type: "youtube" | "article";
  url: string;
  title: string;
  content: string;
}

function getYouTubeId(url: string): string | null {
  const match = url.match(YOUTUBE_REGEX);
  return match ? match[1] : null;
}

export function subtitlesToPlainText(content: string): string {
  return content
    .replace(/\r/g, "")
    .replace(/WEBVTT[\s\S]*?\n\n/g, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
    .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getGroqApiKey(): Promise<string | null> {
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) {
    return process.env.GROQ_API_KEY.trim();
  }

  const sec = spawn(
    [
      "security",
      "find-generic-password",
      "-s",
      GROQ_KEYCHAIN_SERVICE,
      "-a",
      GROQ_KEYCHAIN_ACCOUNT,
      "-w",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await sec.exited;
  if (exitCode !== 0) return null;

  const key = (await new Response(sec.stdout).text()).trim();
  return key || null;
}

async function resolveYtDlpPath(): Promise<string> {
  for (const candidate of YT_DLP_CANDIDATES) {
    if (!candidate.includes("/")) {
      return candidate;
    }
    if (await stat(candidate).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  return "yt-dlp";
}

async function getYtDlpJsRuntimeArgs(): Promise<string[]> {
  const bunPathCandidates = [process.execPath, join(process.env.HOME || "~", ".bun/bin/bun")].filter(
    Boolean,
  ) as string[];
  for (const bunPath of bunPathCandidates) {
    if (await stat(bunPath).then(() => true).catch(() => false)) {
      return ["--js-runtimes", `bun:${bunPath}`];
    }
  }
  return [];
}

async function tryExtractSubtitlesViaYtDlp(videoId: string): Promise<string | null> {
  const basePath = join(TEMP_DIR, `yt_${videoId}_${Date.now()}`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const ytDlpPath = await resolveYtDlpPath();
  const jsRuntimeArgs = await getYtDlpJsRuntimeArgs();

  const cmd = spawn(
    [
      ytDlpPath,
      ...jsRuntimeArgs,
      "--skip-download",
      "--no-playlist",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "ro.*,ro,en.*,en",
      "--sub-format",
      "vtt/srt/best",
      "--output",
      `${basePath}.%(ext)s`,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await cmd.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(cmd.stderr).text();
    console.error("yt-dlp subtitle extraction error:", stderr.substring(0, 300));
    return null;
  }

  const tempEntries = await readdir(TEMP_DIR).catch(() => []);
  const baseName = basePath.split("/").pop() || "";
  const subtitleFile = tempEntries.find(
    (entry) =>
      entry.startsWith(baseName) && (entry.endsWith(".vtt") || entry.endsWith(".srt")),
  );

  if (!subtitleFile) {
    return null;
  }

  const subtitlePath = join(TEMP_DIR, subtitleFile);
  const subtitleText = await readFile(subtitlePath, "utf-8").catch(() => "");
  await unlink(subtitlePath).catch(() => {});

  const transcript = subtitlesToPlainText(subtitleText);
  return transcript || null;
}

/**
 * Download YouTube audio and transcribe with Groq Whisper
 */
async function transcribeYouTubeAudio(videoId: string): Promise<string | null> {
  const startedAt = Date.now();
  const audioBasePath = join(TEMP_DIR, `yt_${videoId}_${Date.now()}`);
  const audioPath = `${audioBasePath}.mp3`;
  const ytDlpPath = await resolveYtDlpPath();
  const jsRuntimeArgs = await getYtDlpJsRuntimeArgs();

  try {
    // Download audio only (mp3 format, max 10 min)
    const dl = spawn([
      ytDlpPath,
      ...jsRuntimeArgs,
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--match-filter", `duration <= ${MAX_AUDIO_DURATION}`,
      "-o",
      `${audioBasePath}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { stdout: "pipe", stderr: "pipe" });

    const dlExit = await dl.exited;
    if (dlExit !== 0) {
      const stderr = await new Response(dl.stderr).text();
      console.error("yt-dlp error:", stderr.substring(0, 300));
      return null;
    }

    // Find the output file - yt-dlp may use the exact path or slightly differ
    let actualPath = audioPath;
    try {
      await stat(audioPath);
    } catch {
      // Try without extension - yt-dlp adds its own
      const base = audioBasePath;
      for (const ext of [".mp3", ".m4a", ".ogg", ".webm"]) {
        try {
          await stat(base + ext);
          actualPath = base + ext;
          break;
        } catch {}
      }
    }

    const fileStat = await stat(actualPath).catch(() => null);
    if (!fileStat) {
      console.error("Audio file not found after download");
      return null;
    }

    if (fileStat.size > 25 * 1024 * 1024) {
      console.error("Audio too large for Groq (>25MB)");
      await unlink(actualPath).catch(() => {});
      return null;
    }

    // Read audio and transcribe with Groq
    const audioBuffer = await Bun.file(actualPath).arrayBuffer();
    const apiKey = await getGroqApiKey();
    if (!apiKey) {
      console.error("Missing GROQ_API_KEY env and Keychain fallback key");
      await unlink(actualPath).catch(() => {});
      return null;
    }

    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq({ apiKey });

    const file = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });
    const result = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3",
    });

    // Cleanup
    await unlink(actualPath).catch(() => {});
    const latencySec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Groq Whisper transcription complete in ${latencySec}s`);

    return result.text.trim();
  } catch (error) {
    console.error("YouTube audio transcription error:", error);
    await unlink(audioPath).catch(() => {});
    await unlink(`${audioBasePath}.m4a`).catch(() => {});
    await unlink(`${audioBasePath}.ogg`).catch(() => {});
    await unlink(`${audioBasePath}.webm`).catch(() => {});
    return null;
  }
}

async function fetchYouTube(videoId: string, url: string): Promise<ExtractedContent | null> {
  try {
    let details = await getVideoDetails({ videoID: videoId, lang: "en" }).catch(() => null);
    if (!details) {
      details = await getVideoDetails({ videoID: videoId, lang: "ro" }).catch(() => null);
    }
    const title = details?.title || "Unknown";

    // Primary path: yt-dlp subtitle extraction and local .vtt/.srt detection
    const subtitleTranscript = await tryExtractSubtitlesViaYtDlp(videoId);
    if (subtitleTranscript) {
      return {
        type: "youtube",
        url,
        title,
        content: subtitleTranscript.substring(0, 6000),
      };
    }

    // Fallback: download audio and transcribe with Groq
    console.log("No subtitles found (.vtt/.srt), trying audio transcription...");
    const transcript = await transcribeYouTubeAudio(videoId);

    if (transcript) {
      return {
        type: "youtube",
        url,
        title,
        content: transcript.substring(0, 6000),
      };
    }

    return {
      type: "youtube",
      url,
      title,
      content: "[Could not extract content - no subtitles and audio transcription failed]",
    };
  } catch (error) {
    console.error("YouTube fetch error:", error);
    return null;
  }
}

async function fetchArticle(url: string): Promise<ExtractedContent | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { type: "article", url, title: url, content: "[Not an HTML page]" };
    }
    const html = await response.text();
    const { document } = parseHTML(html);
    const reader = new Readability(document as any);
    const article = reader.parse();
    if (!article || !article.textContent) {
      return { type: "article", url, title: "Unknown", content: "[Could not extract content]" };
    }
    const cleanText = article.textContent.replace(/\n{3,}/g, "\n\n").trim();
    return {
      type: "article",
      url,
      title: article.title || url,
      content: cleanText.substring(0, 6000),
    };
  } catch (error) {
    console.error("Article fetch error:", error);
    return null;
  }
}

export async function extractUrlContent(text: string): Promise<ExtractedContent[]> {
  const urls = text.match(URL_REGEX);
  if (!urls) return [];
  const unique = [...new Set(urls)].slice(0, 3);
  const results: ExtractedContent[] = [];
  for (const url of unique) {
    const youtubeId = getYouTubeId(url);
    if (youtubeId) {
      const result = await fetchYouTube(youtubeId, url);
      if (result) results.push(result);
    } else {
      const result = await fetchArticle(url);
      if (result) results.push(result);
    }
  }
  return results;
}

export function formatExtractedContent(contents: ExtractedContent[]): string {
  if (contents.length === 0) return "";
  const parts = contents.map(c => {
    if (c.type === "youtube") {
      return `[YouTube Video: "${c.title}"]\nTranscript:\n${c.content}`;
    }
    return `[Web Page: "${c.title}"]\nContent:\n${c.content}`;
  });
  return "EXTRACTED CONTENT FROM URLS:\n" + parts.join("\n\n---\n\n");
}
