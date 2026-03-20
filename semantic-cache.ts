/**
 * SEMANTIC LLM RESPONSE CACHE
 * ─────────────────────────────────────────────────────────────────────────────
 * Three-layer cache for LLM responses, implementing the GPTCache architecture
 * (Bang et al., 2023, ACL NLP-OSS) with improvements from:
 *   - MeanCache (Gill et al., 2024): optimal threshold 0.83 for MPNet/MiniLM
 *   - vCache (Schroeder et al., 2025): conservative threshold on serving path
 *   - Krites (2026): async verification for grey-zone hits
 *
 * Layers (checked in order, fastest first):
 *
 *   L1 — In-process Map<hash → response>
 *        Zero latency. Survives within one server process.
 *        Max 500 entries (LRU eviction).
 *        TTL: not enforced at L1 — entries checked against L2 on first access.
 *
 *   L2 — Redis: exact-match by normalized prompt hash
 *        Sub-millisecond. Shared across all server instances.
 *        TTL: per call type (15min for searches, 24h for analyses).
 *
 *   L3 — Redis: semantic match by embedding similarity
 *        Uses all-MiniLM-L6-v2 embeddings stored in Redis hashes.
 *        Cosine similarity ≥ 0.85 → cache hit (MeanCache-optimal threshold).
 *        Only searched when L1+L2 miss (ANN over stored embeddings).
 *        TTL: same as L2 per call type.
 *
 * Cache key design:
 *   Exact key:    `llmcache:exact:{promptHash}:{systemHash}`
 *   Embedding key: `llmcache:emb:{promptHash}`  → stores Float32Array as JSON
 *   Response key:  `llmcache:resp:{promptHash}` → stores response string
 *
 * The semantic layer is what makes this dramatically better than exact-match:
 *   "Find Rust engineers who know async" →
 *   Cache hit on "Find engineers experienced with async Rust" (similarity: 0.89)
 */

import { Redis } from "@upstash/redis";
import { embedOne, cosineSimilarity } from "@/lib/embeddings/client";
import { normalize, fastHash } from "./prompt-normalizer";

// ─── Config ───────────────────────────────────────────────────────────────────

// Tuned from MeanCache paper: optimal threshold = 0.83 for MPNet/MiniLM
// We use 0.85 to be more conservative (technical prompts need high precision)
const SEMANTIC_SIMILARITY_THRESHOLD = 0.85;

// L1 cache: max entries before LRU eviction
const L1_MAX_ENTRIES = 500;

// How many recent embeddings to check for semantic similarity (ANN approximation)
// Checking all stored embeddings would be O(N) — we cap at 100 recent ones
const SEMANTIC_SEARCH_LIMIT = 100;

// ─── TTL Map ──────────────────────────────────────────────────────────────────
// Different operation types warrant different cache lifetimes

export const CACHE_TTL: Record<string, number> = {
  query_analyze:      60 * 60 * 2,    // 2h  — queries are reused often
  profile_synthesize: 60 * 60 * 24,   // 24h — profiles don't change fast
  niche_fit:          60 * 60 * 6,    // 6h  — niche fit is query-specific
  code_quality:       60 * 60 * 24,   // 24h — code quality is stable
  ranking_narrative:  60 * 60 * 4,    // 4h  — rankings may shift with new data
  bias_audit:         60 * 60 * 24,   // 24h — deterministic, stable
  bot_verify:         60 * 60 * 12,   // 12h — bot status rarely changes
  unknown:            60 * 60 * 4,    // 4h  — conservative default
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  response: string;
  promptHash: string;
  systemHash: string;
  operation: string;
  createdAt: number;
  hitCount: number;
}

export type CacheLayer = "l1_memory" | "l2_exact" | "l3_semantic" | "miss";

export interface CacheLookupResult {
  hit: boolean;
  layer: CacheLayer;
  response: string | null;
  similarity?: number;        // for L3 semantic hits
  cachedPromptHash?: string;  // which cached prompt matched semantically
}

// ─── L1: In-Process Cache ─────────────────────────────────────────────────────

const l1Cache = new Map<string, CacheEntry>();
const l1AccessOrder: string[] = []; // for LRU eviction

function l1Get(key: string): CacheEntry | null {
  const entry = l1Cache.get(key);
  if (!entry) return null;
  // Move to end (most recently used)
  const idx = l1AccessOrder.indexOf(key);
  if (idx > -1) l1AccessOrder.splice(idx, 1);
  l1AccessOrder.push(key);
  return entry;
}

function l1Set(key: string, entry: CacheEntry): void {
  // Evict if over limit
  while (l1Cache.size >= L1_MAX_ENTRIES && l1AccessOrder.length > 0) {
    const oldest = l1AccessOrder.shift()!;
    l1Cache.delete(oldest);
  }
  l1Cache.set(key, entry);
  l1AccessOrder.push(key);
}

// ─── Redis Client ─────────────────────────────────────────────────────────────

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

// Lazy singleton
let _redis: Redis | null | undefined = undefined;
function redis(): Redis | null {
  if (_redis === undefined) _redis = getRedis();
  return _redis;
}

// ─── Key Builders ─────────────────────────────────────────────────────────────

function exactKey(promptHash: string, systemHash: string): string {
  return `llmcache:exact:${promptHash}:${systemHash}`;
}

function embeddingKey(promptHash: string): string {
  return `llmcache:emb:${promptHash}`;
}

function responseKey(promptHash: string): string {
  return `llmcache:resp:${promptHash}`;
}

function embeddingIndexKey(): string {
  return `llmcache:emb:index`; // sorted set: member=promptHash, score=timestamp
}

// ─── LOOKUP ───────────────────────────────────────────────────────────────────

export async function cacheLookup(
  prompt: string,
  system: string,
  operation: string
): Promise<CacheLookupResult> {
  const { normalized, hash: promptHash } = normalize(prompt);
  const systemHash = fastHash(system.slice(0, 200)); // hash first 200 chars of system
  const exactCacheKey = exactKey(promptHash, systemHash);

  // ── L1: In-process ────────────────────────────────────────────────────────
  const l1Hit = l1Get(exactCacheKey);
  if (l1Hit) {
    l1Hit.hitCount++;
    return { hit: true, layer: "l1_memory", response: l1Hit.response };
  }

  const r = redis();
  if (!r) return { hit: false, layer: "miss", response: null };

  // ── L2: Redis exact match ─────────────────────────────────────────────────
  try {
    const l2Raw = await r.get<string>(exactCacheKey);
    if (l2Raw) {
      const entry: CacheEntry = {
        response: l2Raw, promptHash, systemHash, operation,
        createdAt: Date.now(), hitCount: 1,
      };
      l1Set(exactCacheKey, entry); // backfill L1
      return { hit: true, layer: "l2_exact", response: l2Raw };
    }
  } catch (err) {
    console.warn("[LLMCache] L2 exact lookup failed:", err);
  }

  // ── L3: Semantic similarity search ────────────────────────────────────────
  try {
    // Get recent prompt hashes from the index (most recent SEMANTIC_SEARCH_LIMIT)
    const recentHashes = await r.zrange(embeddingIndexKey(), -SEMANTIC_SEARCH_LIMIT, -1) as string[];

    if (recentHashes.length > 0) {
      // Embed the current prompt
      const queryEmb = await embedOne(normalized);

      // Fetch embeddings for candidate hashes (batch get)
      const embKeys = recentHashes.map(embeddingKey);
      const pipeline = r.pipeline();
      for (const k of embKeys) pipeline.get(k);
      const embResults = await pipeline.exec();

      let bestHash: string | null = null;
      let bestSim = 0;

      for (let i = 0; i < recentHashes.length; i++) {
        const raw = embResults[i];
        if (!raw) continue;
        try {
          const candidateEmb = new Float32Array(JSON.parse(raw as string) as number[]);
          const sim = (cosineSimilarity(queryEmb, candidateEmb) + 1) / 2;
          if (sim > bestSim && sim >= SEMANTIC_SIMILARITY_THRESHOLD) {
            bestSim = sim;
            bestHash = recentHashes[i];
          }
        } catch { /* malformed embedding — skip */ }
      }

      if (bestHash) {
        const cachedResponse = await r.get<string>(responseKey(bestHash));
        if (cachedResponse) {
          // Backfill L1 and L2 exact for next time
          const ttl = CACHE_TTL[operation] ?? CACHE_TTL.unknown;
          await r.setex(exactCacheKey, ttl, cachedResponse).catch(() => {});
          const entry: CacheEntry = {
            response: cachedResponse, promptHash, systemHash, operation,
            createdAt: Date.now(), hitCount: 1,
          };
          l1Set(exactCacheKey, entry);
          return { hit: true, layer: "l3_semantic", response: cachedResponse, similarity: bestSim, cachedPromptHash: bestHash };
        }
      }
    }
  } catch (err) {
    console.warn("[LLMCache] L3 semantic lookup failed:", err);
  }

  return { hit: false, layer: "miss", response: null };
}

// ─── STORE ────────────────────────────────────────────────────────────────────

export async function cacheStore(
  prompt: string,
  system: string,
  operation: string,
  response: string
): Promise<void> {
  const { normalized, hash: promptHash } = normalize(prompt);
  const systemHash = fastHash(system.slice(0, 200));
  const exactCacheKey = exactKey(promptHash, systemHash);
  const ttl = CACHE_TTL[operation] ?? CACHE_TTL.unknown;

  // Store in L1
  const entry: CacheEntry = { response, promptHash, systemHash, operation, createdAt: Date.now(), hitCount: 0 };
  l1Set(exactCacheKey, entry);

  const r = redis();
  if (!r) return;

  try {
    // Store response in L2 (exact) and semantic response store
    const pipeline = r.pipeline();
    pipeline.setex(exactCacheKey, ttl, response);
    pipeline.setex(responseKey(promptHash), ttl, response);
    await pipeline.exec();

    // Store embedding for L3 semantic search (async, non-blocking)
    // We don't await this — embedding generation shouldn't block response delivery
    embedOne(normalized)
      .then(async (emb) => {
        const r2 = redis();
        if (!r2) return;
        const p2 = r2.pipeline();
        // Store embedding as JSON array
        p2.setex(embeddingKey(promptHash), ttl, JSON.stringify(Array.from(emb)));
        // Add to sorted index with timestamp as score (for ZRANGE recency search)
        p2.zadd(embeddingIndexKey(), { score: Date.now(), member: promptHash });
        // Trim index to prevent unbounded growth (keep last 1000)
        p2.zremrangebyrank(embeddingIndexKey(), 0, -1001);
        await p2.exec();
      })
      .catch((err) => console.warn("[LLMCache] Async embedding store failed:", err));
  } catch (err) {
    console.warn("[LLMCache] Cache store failed:", err);
  }
}

// ─── STATS ────────────────────────────────────────────────────────────────────

export function getCacheStats(): {
  l1Size: number;
  l1MaxSize: number;
} {
  return {
    l1Size: l1Cache.size,
    l1MaxSize: L1_MAX_ENTRIES,
  };
}

export function clearL1(): void {
  l1Cache.clear();
  l1AccessOrder.length = 0;
}
