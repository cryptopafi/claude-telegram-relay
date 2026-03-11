/**
 * Fact-Checker Module for Lis PA
 *
 * Post-processes Claude responses before sending to Telegram.
 * Detects potentially unverified claims and adds disclaimers.
 *
 * Strategy (per Gemini audit recommendation):
 * - V1: Pattern-based detection for prices, dates, statistics, URLs
 * - Verification against Cortex (high-confidence knowledge base)
 * - Explicit "unverified" flagging for training-data-only claims
 * - Graceful degradation: if verification fails, append disclaimer
 */

import { searchCortex } from "./cortex-client";

// Patterns that indicate factual claims needing verification
const PRICE_PATTERN = /(?:\$|€|£|RON|USD|EUR)\s*[\d,.]+(?:\s*(?:\/month|\/year|\/hr|pe luna|pe an))?/gi;
const PERCENTAGE_PATTERN = /\b\d+(?:\.\d+)?%/g;
const DATE_CLAIM_PATTERN = /(?:in|din|pe|from|since|until)\s+(?:20\d{2}|ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie|january|february|march|april|may|june|july|august|september|october|november|december)/gi;
const STATISTIC_PATTERN = /\b(?:approximately|circa|about|roughly|around|peste|sub)\s+[\d,.]+\s*(?:million|billion|thousand|milioane|miliarde|mii)?/gi;

interface FactCheckResult {
  originalResponse: string;
  processedResponse: string;
  claimsFound: number;
  unverifiedClaims: string[];
  verificationSkipped: boolean;
}

/**
 * Check if a response contains claims that should be verified.
 * Returns true if the response has factual claims worth checking.
 */
function hasVerifiableClaims(text: string): boolean {
  // Reset lastIndex before .test() to avoid stale state from global regexes
  PRICE_PATTERN.lastIndex = 0;
  PERCENTAGE_PATTERN.lastIndex = 0;
  STATISTIC_PATTERN.lastIndex = 0;
  DATE_CLAIM_PATTERN.lastIndex = 0;
  return (
    PRICE_PATTERN.test(text) ||
    PERCENTAGE_PATTERN.test(text) ||
    STATISTIC_PATTERN.test(text) ||
    DATE_CLAIM_PATTERN.test(text)
  );
}

/**
 * Extract potential factual claims from a response.
 * V1: Pattern-based extraction for easily identifiable entities.
 */
function extractClaims(text: string): string[] {
  const claims: string[] = [];

  // Reset regex lastIndex
  PRICE_PATTERN.lastIndex = 0;
  PERCENTAGE_PATTERN.lastIndex = 0;
  DATE_CLAIM_PATTERN.lastIndex = 0;
  STATISTIC_PATTERN.lastIndex = 0;

  let match;
  while ((match = PRICE_PATTERN.exec(text)) !== null) {
    claims.push(match[0]);
  }
  while ((match = PERCENTAGE_PATTERN.exec(text)) !== null) {
    claims.push(match[0]);
  }
  while ((match = STATISTIC_PATTERN.exec(text)) !== null) {
    claims.push(match[0]);
  }
  while ((match = DATE_CLAIM_PATTERN.exec(text)) !== null) {
    claims.push(match[0]);
  }

  return [...new Set(claims)]; // deduplicate
}

const VERIFY_TIMEOUT_MS = 3000; // 3s per claim max

/**
 * Race a promise against a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Try to verify a claim against Cortex knowledge base.
 * Returns true if Cortex has supporting evidence with high confidence.
 * Timeout: 3s per claim to prevent latency spikes.
 */
async function verifyClaim(claim: string): Promise<boolean> {
  return withTimeout(verifyClaimInner(claim), VERIFY_TIMEOUT_MS, false);
}

async function verifyClaimInner(claim: string): Promise<boolean> {
  try {
    // Search across procedures and rules for broader coverage
    const [procResults, ruleResults] = await Promise.all([
      searchCortex(claim, "procedures", 2).catch(() => []),
      searchCortex(claim, "rules", 2).catch(() => []),
    ]);
    const allResults = [...(procResults || []), ...(ruleResults || [])];
    if (allResults.length > 0) {
      const topScore = Math.max(...allResults.map(r => r?.score ?? 0));
      return topScore > 0.7;
    }
  } catch {
    // Cortex unreachable — can't verify
  }
  return false;
}

/**
 * Main fact-checking pipeline.
 * Runs after Claude generates a response, before sending to Telegram.
 *
 * Design principles:
 * - Fast: only checks responses with detectable claims
 * - Non-blocking: if verification fails, append disclaimer instead of blocking
 * - Conservative: flags uncertainty, doesn't silently remove content
 */
export async function factCheck(response: string): Promise<FactCheckResult> {
  const result: FactCheckResult = {
    originalResponse: response,
    processedResponse: response,
    claimsFound: 0,
    unverifiedClaims: [],
    verificationSkipped: false,
  };

  // Skip short responses or responses that are clearly conversational
  if (response.length < 100 || !hasVerifiableClaims(response)) {
    return result;
  }

  const claims = extractClaims(response);
  result.claimsFound = claims.length;

  if (claims.length === 0) {
    return result;
  }

  // Verify claims in parallel with overall timeout
  try {
    const verifications = await withTimeout(
      Promise.all(claims.map(async (claim) => ({
        claim,
        verified: await verifyClaim(claim),
      }))),
      10000, // 10s max for entire batch
      claims.map((claim) => ({ claim, verified: false })),
    );
    for (const { claim, verified } of verifications) {
      if (!verified) {
        result.unverifiedClaims.push(claim);
      }
    }
  } catch {
    // If verification pipeline fails entirely, mark as skipped
    result.verificationSkipped = true;
  }

  // Append disclaimer when verification was skipped entirely OR multiple claims unverified
  if (result.verificationSkipped) {
    result.processedResponse = response + "\n\n[Verificarea factelor nu a putut fi completata - verifica manual]";
  } else if (result.unverifiedClaims.length >= 2) {
    result.processedResponse = response + "\n\n[Date neverificate - verifica inainte de a actiona pe baza lor]";
  }

  return result;
}

/**
 * Log fact-check results for observability (Gemini HIGH finding).
 */
export function logFactCheck(result: FactCheckResult, userMessage: string): void {
  if (result.claimsFound > 0) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      messageLength: userMessage.length,
      claimsFound: result.claimsFound,
      unverifiedCount: result.unverifiedClaims.length,
      verificationSkipped: result.verificationSkipped,
    };
    console.log(`[FACT-CHECK] ${JSON.stringify(logEntry)}`);
  }
}
