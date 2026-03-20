/**
 * SEARCH PIPELINE ORCHESTRATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * The single entry point that wires every agent together in the correct order.
 *
 * Full pipeline:
 *   Agent 0: InputSanitizer      → blocks injections, classifies input
 *   Agent 1: QueryAnalyzer       → gibberish → expert query → search signals
 *   Agent 2: DiscoveryOrchest.   → 8 strategies, bot filter, signal scoring
 *   Agent 3: ProfileAnalyzer     → deep GitHub dive per candidate (cached 24h)
 *   Agent 4: SemanticRanker      → 9-dimension scoring + full fairness suite
 *
 * This function is called by the /api/search route.
 * It returns a SearchResult that the UI renders.
 */

import { analyzeQuery } from "@/lib/agents/query-analyzer";
import { discoverCandidates } from "@/lib/agents/discovery-orchestrator";
import { analyzeProfile } from "@/lib/agents/profile-analyzer";
import { rankCandidates } from "@/lib/agents/ranking";
import { cacheGet, cacheSet } from "@/lib/cache/redis";
import type { RankedResult } from "@/lib/agents/ranking";
import type { QueryAnalysis } from "@/lib/agents/query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  query: QueryAnalysis;
  results: RankedResult[];
  totalCandidatesDiscovered: number;
  totalCandidatesAnalyzed: number;
  searchDurationMs: number;
  cacheHit: boolean;
}

export interface SearchProgress {
  stage: "sanitizing" | "analyzing_query" | "discovering" | "profiling" | "ranking" | "complete";
  message: string;
  candidatesFound?: number;
  candidatesAnalyzed?: number;
}

// ─── Cache key for full search results ───────────────────────────────────────
// 15 min TTL — search results can change as new profiles get cached

function searchCacheKey(rawQuery: string): string {
  const norm = rawQuery.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
  const hash = Buffer.from(norm).toString("base64url").slice(0, 32);
  return `search:v2:${hash}`;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * runSearchPipeline — the full end-to-end search.
 *
 * @param rawQuery       The raw string the user typed (may be gibberish)
 * @param onProgress     Optional callback for streaming progress updates
 * @param forceRefresh   Bypass all caches
 */
export async function runSearchPipeline(
  rawQuery: string,
  onProgress?: (progress: SearchProgress) => void,
  forceRefresh = false
): Promise<SearchResult> {
  const t0 = Date.now();
  const emit = (p: SearchProgress) => onProgress?.(p);

  // ── Check search-level cache ──────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = await cacheGet<SearchResult>(searchCacheKey(rawQuery));
    if (cached) {
      return { ...cached, cacheHit: true };
    }
  }

  // ── Stage 0 + 1: Sanitize + Query Analysis ────────────────────────────────
  emit({ stage: "analyzing_query", message: "Understanding your query…" });

  const query = await analyzeQuery(rawQuery);

  // If sanitizer blocked it (injection / off-topic), it already threw.
  // If the query was rewritten substantially, show what we understood.

  // ── Stage 2: Discovery ────────────────────────────────────────────────────
  emit({
    stage: "discovering",
    message: `Searching GitHub via 8 unconventional strategies for: "${query.rewrite.expertQuery.slice(0, 60)}…"`,
  });

  const discovered = await discoverCandidates(query);

  emit({
    stage: "profiling",
    message: `Found ${discovered.length} candidates. Deep-analyzing each profile…`,
    candidatesFound: discovered.length,
  });

  // ── Stage 3: Profile Analysis (parallel, cached per-user) ─────────────────
  const profileResults = await Promise.allSettled(
    discovered.map(async (candidate, i) => {
      const profile = await analyzeProfile(
        candidate.user,
        candidate.repos,
        query,
        forceRefresh
      );

      emit({
        stage: "profiling",
        message: `Analyzed ${i + 1}/${discovered.length}: ${candidate.user.login}`,
        candidatesFound: discovered.length,
        candidatesAnalyzed: i + 1,
      });

      return profile;
    })
  );

  const profiles = profileResults
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<typeof r extends PromiseFulfilledResult<infer T> ? T : never>).value);

  // ── Stage 4: Ranking ──────────────────────────────────────────────────────
  emit({
    stage: "ranking",
    message: `Scoring ${profiles.length} profiles across 9 dimensions + fairness audit…`,
    candidatesFound: discovered.length,
    candidatesAnalyzed: profiles.length,
  });

  const ranked = await rankCandidates(query, profiles, discovered);

  emit({
    stage: "complete",
    message: `Found ${ranked.length} ranked results`,
    candidatesFound: discovered.length,
    candidatesAnalyzed: profiles.length,
  });

  const result: SearchResult = {
    query,
    results: ranked,
    totalCandidatesDiscovered: discovered.length,
    totalCandidatesAnalyzed: profiles.length,
    searchDurationMs: Date.now() - t0,
    cacheHit: false,
  };

  // Cache for 15 minutes
  await cacheSet(searchCacheKey(rawQuery), result, 60 * 15);

  return result;
}
