export type NexusDepth = "standard" | "deep";

export interface NexusCommand {
  depth: NexusDepth;
  topic: string;
  mode: "manual" | "auto";
}

const NEXUS_COMMAND_REGEX = /^\/nexus(?:@[\w_]+)?(?:\s+(.*))?$/i;

export function escapeTelegramMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function parseNexusCommand(text: string): NexusCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(NEXUS_COMMAND_REGEX);
  if (!match) {
    return null;
  }

  const remainder = (match[1] || "").trim();
  if (!remainder) {
    return { depth: "standard", topic: "", mode: "manual" };
  }

  const lower = remainder.toLowerCase();
  if (lower.startsWith("auto deep ")) {
    return { depth: "deep", topic: remainder.slice(10).trim(), mode: "auto" };
  }
  if (lower === "auto deep") {
    return { depth: "deep", topic: "", mode: "auto" };
  }
  if (lower.startsWith("auto ")) {
    return { depth: "standard", topic: remainder.slice(5).trim(), mode: "auto" };
  }
  if (lower === "auto") {
    return { depth: "standard", topic: "", mode: "auto" };
  }
  if (lower.startsWith("deep ")) {
    return { depth: "deep", topic: remainder.slice(5).trim(), mode: "manual" };
  }
  if (lower === "deep") {
    return { depth: "deep", topic: "", mode: "manual" };
  }
  if (lower.startsWith("opus ")) {
    return { depth: "deep", topic: remainder.slice(5).trim(), mode: "manual" };
  }
  if (lower === "opus") {
    return { depth: "deep", topic: "", mode: "manual" };
  }

  return { depth: "standard", topic: remainder, mode: "manual" };
}

export function keywordsFromTopic(topic: string): string {
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return Array.from(new Set(tokens)).slice(0, 12).join(",");
}

export function isNexusUrlTopic(topic: string): boolean {
  return /^https?:\/\//i.test(topic.trim());
}

export function fallbackNexusTopicFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = parsed.pathname || "/";
    pathname = pathname.replace(/\/{2,}/g, "/");
    if (pathname !== "/" && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${host}${pathname}`.slice(0, 100);
  } catch {
    return rawUrl.trim().replace(/^https?:\/\//i, "").slice(0, 100);
  }
}

export function buildNexusCompletionMessage(depth: NexusDepth, summary: string, reportPath: string): string {
  const escapedSummary = escapeTelegramMarkdownV2(String(summary || "Summary unavailable").slice(0, 400));
  const escapedPath = escapeTelegramMarkdownV2(reportPath || "unknown");
  const escapedDepth = escapeTelegramMarkdownV2(depth);
  return `*NEXUS ${escapedDepth}*\n${escapedSummary}\n\nPath: \`${escapedPath}\``;
}
