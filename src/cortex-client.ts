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

// ===== PROCEDURES =====

interface Procedure {
  id: string;
  slug: string;
  problem: string;
  solution_steps: string[];
  domain: string;
  difficulty: string;
  success_rate: number | null;
  times_applied: number;
}

/**
 * Store a procedure in Cortex
 */
async function storeProcedure(data: {
  problem: string;
  solution_steps: string[];
  domain: string;
  context?: string;
  error_signatures?: string[];
  verification?: string;
  difficulty?: "easy" | "medium" | "hard";
  tags?: string[];
}): Promise<{ id: string; slug: string; status: string }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    const response = await fetch(`${CORTEX_URL}/api/procedures`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      console.error("Cortex store procedure failed:", response.status);
      return { id: "", slug: "", status: "error" };
    }

    return await response.json();
  } catch (error) {
    console.error("Cortex store procedure error:", error);
    return { id: "", slug: "", status: "error" };
  }
}

/**
 * Search procedures in Cortex
 */
async function searchProcedures(
  query?: string,
  error_signature?: string,
  domain?: string,
  limit: number = 3
): Promise<Procedure[]> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    const body: any = { limit };
    if (query) body.query = query;
    if (error_signature) body.error_signature = error_signature;
    if (domain) body.domain = domain;

    const response = await fetch(`${CORTEX_URL}/api/procedures/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.procedures || [];
  } catch (error) {
    console.error("Cortex search procedures error:", error);
    return [];
  }
}

/**
 * Report procedure feedback to Cortex
 */
async function reportProcedureFeedback(
  id: string,
  feedback_type: "applied_success" | "applied_failure" | "wrong_match",
  notes?: string
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (CORTEX_API_KEY) {
      headers.Authorization = `Bearer ${CORTEX_API_KEY}`;
    }

    await fetch(`${CORTEX_URL}/api/procedures/${id}/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ feedback_type, notes }),
    });
  } catch (error) {
    console.error("Cortex report feedback error:", error);
  }
}

/**
 * Get relevant procedures from Cortex for a problem
 */
export async function getCortexProcedures(query: string): Promise<string> {
  const procedures = await searchProcedures(query, undefined, undefined, 3);

  if (procedures.length === 0) {
    return "";
  }

  return (
    "RELEVANT PROCEDURES (from past solutions):\n" +
    procedures
      .map((p, i) => {
        const quality = p.times_applied > 0
          ? ` [Success: ${Math.round((p.success_rate || 0) * 100)}% (${p.times_applied} uses)]`
          : " [Untested]";
        const steps = p.solution_steps.map((s, idx) => `  ${idx + 1}. ${s}`).join("\n");
        return `${i + 1}. ${p.problem} [${p.domain}]${quality}\nID: ${p.id}\n${steps}`;
      })
      .join("\n\n")
  );
}

/**
 * Parse [PROCEDURE] tags from Claude's response and store in Cortex.
 * Format: [PROCEDURE: problem | solution1; solution2; solution3 | domain]
 * Returns cleaned response.
 */
export async function processProcedureTags(response: string): Promise<string> {
  let clean = response;

  // [PROCEDURE: problem | steps | domain | tags? | difficulty?]
  const procedureRegex = /\[PROCEDURE:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|\]]+)(?:\s*\|\s*([^|\]]+))?(?:\s*\|\s*([^|\]]+))?\]/gi;

  for (const match of response.matchAll(procedureRegex)) {
    const problem = match[1].trim();
    const solutionSteps = match[2].split(";").map((s) => s.trim()).filter(Boolean);
    const domain = match[3].trim() as any;
    const tags = match[4] ? match[4].split(",").map((t) => t.trim()) : [];
    const difficulty = (match[5]?.trim() || "medium") as "easy" | "medium" | "hard";

    if (problem && solutionSteps.length > 0 && domain) {
      const result = await storeProcedure({
        problem,
        solution_steps: solutionSteps,
        domain,
        tags,
        difficulty,
      });

      if (result.status === "stored") {
        console.log(`Stored procedure: ${result.slug}`);
      } else if (result.status === "duplicate") {
        console.log(`Duplicate procedure detected: ${result.slug}`);
      }
    }

    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}
