/**
 * Cortex Knowledge Base Client
 *
 * Connects the Telegram bot to Cortex for persistent knowledge storage.
 * Similar to memory.ts but uses Cortex REST API instead of Supabase.
 */

const CORTEX_URL = process.env.CORTEX_URL || "http://100.81.233.9:6400";
const CORTEX_API_KEY = process.env.CORTEX_API_KEY || "";

interface CortexSearchResult {
  text: string;
  score: number;
  metadata: Record<string, any>;
}

/**
 * Store knowledge in Cortex
 */
async function storeInCortex(
  text: string,
  collection: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    await fetch(`${CORTEX_URL}/api/store`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, collection, metadata }),
    });
  } catch (error) {
    console.error("Cortex store error:", error);
  }
}

/**
 * Search Cortex knowledge base
 */
async function searchCortex(
  query: string,
  collection?: string,
  limit: number = 5
): Promise<CortexSearchResult[]> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    const response = await fetch(`${CORTEX_URL}/api/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, collection, limit }),
    });

    if (!response.ok) {
      console.error("Cortex search failed:", response.status);
      return [];
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error("Cortex search error:", error);
    return [];
  }
}

/**
 * Get all HARD rules from Cortex
 */
async function getCortexRules(): Promise<string> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    const response = await fetch(`${CORTEX_URL}/api/rules`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      return "";
    }

    const data = await response.json();
    if (!data.rules || data.rules.length === 0) {
      return "";
    }

    return (
      "HARD RULES (must follow):\n" +
      data.rules.map((r: any) => `- [${r.category || "GENERAL"}] ${r.text}`).join("\n")
    );
  } catch (error) {
    console.error("Cortex rules error:", error);
    return "";
  }
}

/**
 * Parse Claude's response for memory intent tags and save to Cortex.
 * Returns cleaned response.
 */
export async function processCortexMemoryIntents(response: string): Promise<string> {
  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await storeInCortex(match[1], "general", { type: "fact", source: "telegram" });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await storeInCortex(match[1], "decisions", {
      type: "goal",
      deadline: match[2] || null,
      status: "active",
      source: "telegram",
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  // For now, just store as a completed goal (Cortex doesn't have update capability yet)
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    await storeInCortex(`Goal completed: ${match[1]}`, "decisions", {
      type: "completed_goal",
      source: "telegram",
      completed_at: new Date().toISOString(),
    });
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Get relevant context from Cortex via semantic search
 */
export async function getCortexContext(query: string): Promise<string> {
  // Search across all collections (don't specify collection)
  const results = await searchCortex(query, undefined, 5);

  if (results.length === 0) {
    return "";
  }

  return (
    "RELEVANT KNOWLEDGE (from Cortex):\n" +
    results
      .map((r) => {
        const source = r.metadata._collection ? `[${r.metadata._collection}]` : "";
        return `${source} ${r.text} (relevance: ${r.score.toFixed(2)})`;
      })
      .join("\n")
  );
}

/**
 * Get HARD rules that must be followed
 */
export async function getCortexRulesContext(): Promise<string> {
  return await getCortexRules();
}

/**
 * Store a conversation message in Cortex
 */
export async function storeTelegramMessage(
  role: "user" | "assistant",
  content: string
): Promise<void> {
  await storeInCortex(content, "conversations", {
    role,
    source: "telegram",
    timestamp: new Date().toISOString(),
  });
}
