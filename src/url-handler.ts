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
import { writeFile, unlink, stat } from "fs/promises";
import { join } from "path";

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const YOUTUBE_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
const YT_DLP_PATH = join(process.env.HOME || "~", ".local/bin/yt-dlp");
const TEMP_DIR = join(process.env.HOME || "~", ".claude-relay/temp");
const MAX_AUDIO_DURATION = 600; // 10 minutes max for transcription

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

/**
 * Download YouTube audio and transcribe with Groq Whisper
 */
async function transcribeYouTubeAudio(videoId: string): Promise<string | null> {
  const audioPath = join(TEMP_DIR, `yt_${videoId}_${Date.now()}.ogg`);

  try {
    // Download audio only (ogg format, max 10 min)
    const dl = spawn([
      YT_DLP_PATH,
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "vorbis",
      "--audio-quality", "5",
      "--max-downloads", "1",
      "--match-filter", `duration <= ${MAX_AUDIO_DURATION}`,
      "-o", audioPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { stdout: "pipe", stderr: "pipe" });

    const dlExit = await dl.exited;
    if (dlExit !== 0) {
      const stderr = await new Response(dl.stderr).text();
      console.error("yt-dlp error:", stderr.substring(0, 300));
      // yt-dlp exits with 101 when --max-downloads stops it, that's OK
      if (dlExit !== 101) return null;
    }

    // Find the output file - yt-dlp may use the exact path or slightly differ
    let actualPath = audioPath;
    try {
      await stat(audioPath);
    } catch {
      // Try without extension - yt-dlp adds its own
      const base = audioPath.replace(/\.[^.]+$/, "");
      for (const ext of [".ogg", ".webm", ".m4a", ".mp3"]) {
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
    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq();

    const file = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });
    const result = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
    });

    // Cleanup
    await unlink(actualPath).catch(() => {});

    return result.text.trim();
  } catch (error) {
    console.error("YouTube audio transcription error:", error);
    await unlink(audioPath).catch(() => {});
    await unlink(audioPath.replace(/\.[^.]+$/, ".ogg")).catch(() => {});
    return null;
  }
}

async function fetchYouTube(videoId: string, url: string): Promise<ExtractedContent | null> {
  try {
    // First try: get captions (fast, free)
    let details = await getVideoDetails({ videoID: videoId, lang: "en" });
    if (!details || !details.subtitles?.length) {
      details = await getVideoDetails({ videoID: videoId, lang: "ro" });
    }

    if (details?.subtitles?.length) {
      const transcript = details.subtitles.map((s: any) => s.text).join(" ");
      return {
        type: "youtube",
        url,
        title: details.title || "Unknown",
        content: transcript.substring(0, 6000),
      };
    }

    // Fallback: download audio and transcribe with Groq
    console.log("No captions found, trying audio transcription...");
    const title = details?.title || "Unknown";
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
      content: "[Could not extract content - no captions and audio transcription failed]",
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
