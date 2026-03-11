import { createHash } from "crypto";

const MAX_ENTRIES = 1000;
const TTL_MS = 60 * 60 * 1000; // 1 hour

type FingerprintEntry = {
  expiresAt: number;
};

const store = new Map<string, FingerprintEntry>();

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cleanup(now = Date.now()): void {
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

export function isDuplicate(text: string): boolean {
  if (!text) return false;

  const now = Date.now();
  cleanup(now);

  const key = fingerprint(text);
  const entry = store.get(key);
  if (!entry) return false;

  if (entry.expiresAt <= now) {
    store.delete(key);
    return false;
  }

  return true;
}

export function markProcessed(text: string): void {
  if (!text) return;

  const now = Date.now();
  cleanup(now);

  const key = fingerprint(text);
  store.set(key, { expiresAt: now + TTL_MS });
  cleanup(now);
}

// Test helper (not used by runtime)
export function __resetDedupForTests(): void {
  store.clear();
}

