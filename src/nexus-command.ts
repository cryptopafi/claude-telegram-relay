export type NexusDepth = "standard" | "deep";

export interface NexusCommand {
  depth: NexusDepth;
  topic: string;
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
    return { depth: "standard", topic: "" };
  }

  const lower = remainder.toLowerCase();
  if (lower.startsWith("deep ")) {
    return { depth: "deep", topic: remainder.slice(5).trim() };
  }
  if (lower === "deep") {
    return { depth: "deep", topic: "" };
  }
  if (lower.startsWith("opus ")) {
    return { depth: "deep", topic: remainder.slice(5).trim() };
  }
  if (lower === "opus") {
    return { depth: "deep", topic: "" };
  }

  return { depth: "standard", topic: remainder };
}

export function keywordsFromTopic(topic: string): string {
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return Array.from(new Set(tokens)).slice(0, 12).join(",");
}

export function buildNexusCompletionMessage(depth: NexusDepth, summary: string, reportPath: string): string {
  const escapedSummary = escapeTelegramMarkdownV2(String(summary || "Summary unavailable").slice(0, 400));
  const escapedPath = escapeTelegramMarkdownV2(reportPath || "unknown");
  const escapedDepth = escapeTelegramMarkdownV2(depth);
  return `*NEXUS ${escapedDepth}*\n${escapedSummary}\n\nPath: \`${escapedPath}\``;
}
