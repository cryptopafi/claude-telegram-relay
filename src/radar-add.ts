import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type RadarSourceType = "youtube_channel" | "reddit" | "twitter" | "rss" | "web";

export interface SourceInfo {
  type: RadarSourceType;
  name: string;
  canonical_url: string;
}

export interface RadarSourceEntry {
  name: string;
  url: string;
  type: RadarSourceType;
  vertical: string;
  active: boolean;
  added: string;
}

interface RadarSourcesConfig {
  verticals: string[];
  sources: RadarSourceEntry[];
}

export type AddRadarSourceResult =
  | { ok: true; info: SourceInfo; entry: RadarSourceEntry; configPath: string }
  | { ok: false; code: "invalid_url" | "exists" | "io_error" | "detect_error"; error: string };

export const DEFAULT_VERTICALS = ["ai", "crypto", "health", "longevity", "tech", "business"];
export const RADAR_SOURCES_PATH = join(
  process.env.HOME || "~",
  ".nexus",
  "config",
  "radar-sources.yaml"
);

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "si"]);

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeRadarUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";

  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }

  const keptParams = new URLSearchParams();
  for (const [key, value] of parsed.searchParams.entries()) {
    const lowered = key.toLowerCase();
    if (lowered.startsWith("utm_")) continue;
    if (TRACKING_PARAMS.has(lowered)) continue;
    keptParams.append(key, value);
  }
  parsed.search = keptParams.toString();

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  }

  return parsed.toString();
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isYoutubeHost(hostname: string): boolean {
  return hostname === "youtube.com" || hostname === "www.youtube.com";
}

function isRedditHost(hostname: string): boolean {
  return hostname === "reddit.com" || hostname === "www.reddit.com";
}

function isTwitterHost(hostname: string): boolean {
  return hostname === "x.com" || hostname === "www.x.com" || hostname === "twitter.com" || hostname === "www.twitter.com";
}

function detectByUrlPattern(parsed: URL): SourceInfo | null {
  const hostname = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  if (isYoutubeHost(hostname)) {
    if (segments[0] === "channel" && segments[1]) {
      const channelId = decodeSegment(segments[1]);
      return {
        type: "youtube_channel",
        name: channelId,
        canonical_url: `https://www.youtube.com/channel/${channelId}`,
      };
    }
    if (segments[0] && segments[0].startsWith("@")) {
      const handle = decodeSegment(segments[0]);
      return {
        type: "youtube_channel",
        name: handle.slice(1) || handle,
        canonical_url: `https://www.youtube.com/${handle}`,
      };
    }
    if (segments[0] === "c" && segments[1]) {
      const channelName = decodeSegment(segments[1]);
      return {
        type: "youtube_channel",
        name: channelName,
        canonical_url: `https://www.youtube.com/c/${channelName}`,
      };
    }
  }

  if (isRedditHost(hostname)) {
    const rIndex = segments.findIndex((segment) => segment.toLowerCase() === "r");
    if (rIndex >= 0 && segments[rIndex + 1]) {
      const subreddit = decodeSegment(segments[rIndex + 1]);
      return {
        type: "reddit",
        name: `r/${subreddit}`,
        canonical_url: `https://www.reddit.com/r/${subreddit}`,
      };
    }
  }

  if (isTwitterHost(hostname)) {
    const account = segments[0] ? decodeSegment(segments[0]) : "timeline";
    return {
      type: "twitter",
      name: account,
      canonical_url: normalizeRadarUrl(parsed.toString()),
    };
  }

  return null;
}

function isRssPathHint(pathname: string): boolean {
  return /(^|\/)(feed|rss|atom)(\/|$)/i.test(pathname);
}

function isRssContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/rss+xml") || normalized.includes("application/atom+xml");
}

function looksLikeRssXml(body: string): boolean {
  const sample = body.slice(0, 4000).toLowerCase();
  return sample.includes("<rss") || sample.includes("<feed");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "radar-add/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...(init.headers || {}),
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim();
}

function readAttribute(tag: string, name: string): string {
  const attr = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return normalizeText(attr?.[1] ?? attr?.[2] ?? attr?.[3]);
}

function discoverRssFromHtml(html: string, baseUrl: string): string | null {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const rel = readAttribute(tag, "rel").toLowerCase();
    const type = readAttribute(tag, "type").toLowerCase();
    if (!rel.includes("alternate")) continue;
    if (!isRssContentType(type)) continue;
    const href = readAttribute(tag, "href");
    if (!href) continue;
    try {
      return normalizeRadarUrl(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
  }
  return null;
}

function fallbackNameFromUrl(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (segment && !/^(feed|rss|atom)$/i.test(segment)) {
      return decodeSegment(segment);
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return urlValue;
  }
}

export async function detectSourceType(rawUrl: string): Promise<SourceInfo> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid_url");
  }

  const normalizedInput = normalizeRadarUrl(parsed.toString());
  const parsedInput = new URL(normalizedInput);
  const patternMatch = detectByUrlPattern(parsedInput);
  if (patternMatch) {
    return patternMatch;
  }

  if (isRssPathHint(parsedInput.pathname)) {
    return {
      type: "rss",
      name: fallbackNameFromUrl(normalizedInput),
      canonical_url: normalizedInput,
    };
  }

  let contentType = "";
  let finalUrl = normalizedInput;
  let body = "";
  let htmlTitle = "";

  try {
    const head = await fetchWithTimeout(normalizedInput, { method: "HEAD" }, 10_000);
    finalUrl = normalizeRadarUrl(head.url || normalizedInput);
    contentType = normalizeText(head.headers.get("content-type")).toLowerCase();
  } catch {
    // Fall through to GET probe.
  }

  if (!contentType || contentType.includes("text/html")) {
    try {
      const getResponse = await fetchWithTimeout(finalUrl, { method: "GET" }, 15_000);
      finalUrl = normalizeRadarUrl(getResponse.url || finalUrl);
      contentType = normalizeText(getResponse.headers.get("content-type")).toLowerCase();
      body = (await getResponse.text()).slice(0, 300_000);
      htmlTitle = extractHtmlTitle(body);
    } catch {
      // Keep fallback path if GET fails.
    }
  }

  if (isRssContentType(contentType)) {
    return {
      type: "rss",
      name: htmlTitle || fallbackNameFromUrl(finalUrl),
      canonical_url: finalUrl,
    };
  }

  if (body && (contentType.includes("xml") || looksLikeRssXml(body))) {
    return {
      type: "rss",
      name: htmlTitle || fallbackNameFromUrl(finalUrl),
      canonical_url: finalUrl,
    };
  }

  const discoveredRss = body ? discoverRssFromHtml(body, finalUrl) : null;
  if (discoveredRss) {
    return {
      type: "rss",
      name: htmlTitle || fallbackNameFromUrl(finalUrl),
      canonical_url: discoveredRss,
    };
  }

  return {
    type: "web",
    name: htmlTitle || fallbackNameFromUrl(finalUrl),
    canonical_url: finalUrl,
  };
}

function normalizeVerticals(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => normalizeText(value).toLowerCase())
        .filter(Boolean)
    )
  );
}

function normalizeSourceEntry(value: unknown): RadarSourceEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const type = normalizeText(raw.type) as RadarSourceType;
  if (!type) return null;

  return {
    name: normalizeText(raw.name) || "Unnamed Source",
    url: normalizeText(raw.url),
    type,
    vertical: normalizeText(raw.vertical).toLowerCase() || "tech",
    active: raw.active !== false,
    added: normalizeText(raw.added) || new Date().toISOString().slice(0, 10),
  };
}

async function loadRadarSourcesConfig(configPath: string): Promise<RadarSourcesConfig> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = (Bun as any).YAML.parse(raw);

    if (Array.isArray(parsed)) {
      return {
        verticals: [...DEFAULT_VERTICALS],
        sources: parsed.map(normalizeSourceEntry).filter(Boolean) as RadarSourceEntry[],
      };
    }

    const asObject = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const sourcesRaw = Array.isArray(asObject.sources) ? asObject.sources : [];

    return {
      verticals: normalizeVerticals(asObject.verticals).length
        ? normalizeVerticals(asObject.verticals)
        : [...DEFAULT_VERTICALS],
      sources: sourcesRaw.map(normalizeSourceEntry).filter(Boolean) as RadarSourceEntry[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { verticals: [...DEFAULT_VERTICALS], sources: [] };
    }
    throw error;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function serializeRadarSourcesConfig(config: RadarSourcesConfig): string {
  const lines: string[] = [];
  lines.push("verticals:");
  for (const vertical of config.verticals) {
    lines.push(`  - ${yamlString(vertical)}`);
  }
  lines.push("sources:");
  for (const source of config.sources) {
    lines.push(`  - name: ${yamlString(source.name)}`);
    lines.push(`    url: ${yamlString(source.url)}`);
    lines.push(`    type: ${yamlString(source.type)}`);
    lines.push(`    vertical: ${yamlString(source.vertical)}`);
    lines.push(`    active: ${source.active ? "true" : "false"}`);
    lines.push(`    added: ${yamlString(source.added)}`);
  }
  return lines.join("\n") + "\n";
}

async function saveRadarSourcesConfig(configPath: string, config: RadarSourcesConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, serializeRadarSourcesConfig(config), "utf-8");
}

function chooseVertical(text: string, allowedVerticals: string[]): string {
  const lowered = text.toLowerCase();
  const checks: Array<[string, string[]]> = [
    ["ai", [" ai", "ai ", "gpt", "llm", "openai", "anthropic", "claude", "gemini"]],
    ["crypto", ["crypto", "bitcoin", "btc", "ethereum", "eth", "defi", "solana", "blockchain", "token"]],
    ["health", ["health", "fitness", "bio", "medical", "nutrition", "wellness"]],
    ["longevity", ["longevity", "aging", "ageing", "lifespan", "senescence"]],
    ["business", ["business", "startup", "saas", "revenue", "marketing", "sales", "finance"]],
    ["tech", ["tech", "software", "developer", "programming", "engineering", "product"]],
  ];

  for (const [vertical, keywords] of checks) {
    if (keywords.some((keyword) => lowered.includes(keyword.trim()))) {
      if (allowedVerticals.includes(vertical)) return vertical;
    }
  }

  if (allowedVerticals.includes("tech")) return "tech";
  return allowedVerticals[0] || "unknown";
}

export async function addRadarSourceFromUrl(
  rawUrl: string,
  configPath: string = RADAR_SOURCES_PATH
): Promise<AddRadarSourceResult> {
  let detected: SourceInfo;
  try {
    detected = await detectSourceType(rawUrl);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes("invalid_url") || message.includes("Invalid URL")) {
      return { ok: false, code: "invalid_url", error: "URL invalid" };
    }
    return { ok: false, code: "detect_error", error: `Detecție eșuată: ${message.slice(0, 250)}` };
  }

  let config: RadarSourcesConfig;
  try {
    config = await loadRadarSourcesConfig(configPath);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return { ok: false, code: "io_error", error: `Nu pot citi config-ul Radar: ${message.slice(0, 250)}` };
  }

  const canonical = normalizeRadarUrl(detected.canonical_url);
  const alreadyExists = config.sources.some((source) => {
    if (!source.url) return false;
    try {
      return normalizeRadarUrl(source.url) === canonical;
    } catch {
      return normalizeText(source.url) === canonical;
    }
  });
  if (alreadyExists) {
    return { ok: false, code: "exists", error: "URL deja există în radar-sources.yaml" };
  }

  const verticals = config.verticals.length ? config.verticals : [...DEFAULT_VERTICALS];
  const suggestedVertical = chooseVertical(`${detected.name} ${canonical}`, verticals);
  const entry: RadarSourceEntry = {
    name: detected.name || fallbackNameFromUrl(canonical),
    url: canonical,
    type: detected.type,
    vertical: suggestedVertical,
    active: true,
    added: new Date().toISOString().slice(0, 10),
  };

  config.sources.push(entry);
  config.verticals = verticals;

  try {
    await saveRadarSourcesConfig(configPath, config);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return { ok: false, code: "io_error", error: `Nu pot salva config-ul Radar: ${message.slice(0, 250)}` };
  }

  return { ok: true, info: detected, entry, configPath };
}
