/**
 * Memory Module
 *
 * Strips memory intent tags from Claude's responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * Tags are parsed and removed before sending to the user.
 * Actual storage is handled by Cortex (cortex-client.ts).
 */

/**
 * Strip memory intent tags from Claude's response.
 */
export async function processMemoryIntents(response: string): Promise<string> {
  let clean = response;

  // [REMEMBER: fact to store]
  clean = clean.replace(/\[REMEMBER:\s*.+?\]/gi, "");

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  clean = clean.replace(/\[GOAL:\s*.+?(?:\s*\|\s*DEADLINE:\s*.+?)?\]/gi, "");

  // [DONE: search text for completed goal]
  clean = clean.replace(/\[DONE:\s*.+?\]/gi, "");

  return clean.trim();
}
