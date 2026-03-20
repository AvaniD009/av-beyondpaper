/**
 * PROMPT NORMALIZER
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonicalizes prompts before hashing so semantically identical prompts
 * get the same cache key regardless of trivial surface differences.
 *
 * Without normalization these are different cache keys:
 *   "Find engineers who know Rust"
 *   "find engineers who know rust"
 *   "Find engineers who know Rust  "   (trailing space)
 *   "Find  engineers who know Rust"    (double space)
 *
 * With normalization they all hash to the same key.
 *
 * Also trims dynamic/ephemeral segments that change per-call but don't
 * meaningfully change the response — things like exact timestamps,
 * random session IDs embedded in prompts, etc.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedPrompt {
  /** The canonicalized prompt string used for cache key generation */
  normalized: string;
  /** SHA-256 hex digest of the normalized prompt (first 32 chars) */
  hash: string;
  /** Whether any normalization was applied */
  wasModified: boolean;
}

// ─── Normalization Rules ──────────────────────────────────────────────────────

/**
 * normalize — produces a canonical form of a prompt for cache keying.
 *
 * Rules applied (in order):
 *   1. Trim leading/trailing whitespace
 *   2. Lowercase (case-insensitive matching)
 *   3. Collapse internal whitespace runs → single space
 *   4. Normalize Unicode (NFKC) — "Ｒust" = "Rust"
 *   5. Strip ISO timestamps (change per-call, don't affect semantics)
 *   6. Strip UUIDs and random hex IDs
 *   7. Normalize punctuation runs ("..." → ".")
 */
export function normalize(prompt: string): NormalizedPrompt {
  const original = prompt;

  let p = prompt
    // Unicode normalization — fullwidth chars, ligatures, etc.
    .normalize("NFKC")
    // Trim
    .trim()
    // Lowercase for case-insensitive matching
    .toLowerCase()
    // Collapse whitespace
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    // Strip ISO 8601 timestamps — these change per request but don't affect semantics
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi, "[timestamp]")
    // Strip UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]")
    // Strip random hex IDs (32+ char hex strings) — e.g. cache keys embedded in prompts
    .replace(/\b[0-9a-f]{32,}\b/gi, "[hash]")
    // Normalize punctuation: "..." → "." 
    .replace(/\.{2,}/g, ".")
    // Normalize quote types to straight quotes
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'");

  return {
    normalized: p,
    hash: fastHash(p),
    wasModified: p !== original.toLowerCase().trim(),
  };
}

// ─── Fast Hash ────────────────────────────────────────────────────────────────
// A deterministic 32-char hex hash for cache keys.
// Not cryptographic — just needs to be consistent and collision-resistant enough.

export function fastHash(input: string): string {
  // FNV-1a 64-bit (approximated in JS with two 32-bit halves)
  let h1 = 0x811c9dc5;
  let h2 = 0x2166f723;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }

  // Also mix in the length to reduce collisions on truncated strings
  h1 ^= input.length;
  h2 ^= input.length >>> 8;

  return (h1 >>> 0).toString(16).padStart(8, "0") +
         (h2 >>> 0).toString(16).padStart(8, "0");
}

// ─── Prompt Fingerprint ───────────────────────────────────────────────────────
// A shorter key for Redis — uses first 16 chars of hash + length suffix

export function promptFingerprint(prompt: string, prefix = "llm"): string {
  const { hash } = normalize(prompt);
  return `${prefix}:${hash}`;
}
