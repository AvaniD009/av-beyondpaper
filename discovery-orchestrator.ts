/**
 * AGENT 2 — DISCOVERY ORCHESTRATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates all 9 discovery strategies in parallel, then:
 *   1. Runs bot detection on all results
 *   2. De-duplicates (keeps best discovery path per person)
 *   3. Generates "why they're overlooked" explanations
 *   4. Enriches with full GitHub profiles
 *   5. Hands off to Agent 3 (ProfileAnalyzer) with bias firewall applied
 */

import {
  topicGraphMiner,
  contributorNetworkTracer,
  hiddenGemScanner,
  forkEvolutionDetector,
  domainLongevityTracer,
  packageEcosystemMiner,
  crossDomainTransferDetector,
  directGitHubSearch,
  STRATEGY_WEIGHTS,
  type RawDiscovery,
  type StrategyName,
} from "./discovery-strategies";
import { detectBot, type BotDetectionResult } from "./bot-detector";
import { getGitHubUser, getUserRepos, type GitHubUser, type GitHubRepo } from "@/lib/github/client";
import type { QueryAnalysis } from "./query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredCandidate {
  user: GitHubUser;
  repos: GitHubRepo[];
  /** The best discovery path for this person (highest signal strength) */
  primaryDiscovery: RawDiscovery;
  /** All strategies that found this person */
  allDiscoveries: RawDiscovery[];
  /** Bot detection result */
  botResult: BotDetectionResult;
  /** Composite signal score (0–10) */
  signalScore: number;
  /** Human-readable explanation of why they're hard to find */
  whyOverlooked: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_RAW_DISCOVERIES = 80;  // Before dedup + bot filter
const MAX_ENRICHED = 15;         // After all filters, before Agent 3
const MIN_PUBLIC_REPOS = 2;      // Must have at least some public work

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * discoverCandidates — the full Agent 2 pipeline.
 *
 * Fan-out → dedup → bot-filter → enrich → score → return
 *
 * Each strategy runs independently — failure of one never blocks others.
 * The union of strategies surfaces engineers invisible to any single approach.
 */
export async function discoverCandidates(
  analysis: QueryAnalysis
): Promise<DiscoveredCandidate[]> {
  const { domains, requiredSkills, githubSearchTerms, languages, bonusSignals } = analysis;

  console.log(`[Discovery] Starting 8-strategy fan-out for query: "${analysis.rewrite.expertQuery}"`);
  const startTime = Date.now();

  // ── Fan-out: all strategies run in parallel ───────────────────────────────
  const [
    topicResults,
    contributorResults,
    hiddenGemResults,
    forkResults,
    longevityResults,
    packageResults,
    crossDomainResults,
    directResults,
  ] = await Promise.allSettled([
    topicGraphMiner(domains, requiredSkills),
    contributorNetworkTracer(githubSearchTerms, domains),
    hiddenGemScanner(githubSearchTerms, requiredSkills),
    forkEvolutionDetector(githubSearchTerms),
    domainLongevityTracer(requiredSkills, domains),
    packageEcosystemMiner(requiredSkills, languages),
    crossDomainTransferDetector(domains, requiredSkills),
    directGitHubSearch(githubSearchTerms, languages),
  ]);

  // Collect all raw discoveries (gracefully handle any strategy failures)
  const allRaw: RawDiscovery[] = [];
  const strategyResultPairs = [
    [topicResults, "topic_graph"],
    [contributorResults, "contributor_network"],
    [hiddenGemResults, "hidden_gem"],
    [forkResults, "fork_evolution"],
    [longevityResults, "domain_longevity"],
    [packageResults, "package_ecosystem"],
    [crossDomainResults, "cross_domain_transfer"],
    [directResults, "direct_search"],
  ] as const;

  for (const [result, strategy] of strategyResultPairs) {
    if (result.status === "fulfilled") {
      allRaw.push(...result.value);
      console.log(`[Discovery] ${strategy}: ${result.value.length} raw results`);
    } else {
      console.warn(`[Discovery] ${strategy} failed:`, result.reason?.message ?? result.reason);
    }
  }

  console.log(`[Discovery] ${allRaw.length} raw discoveries in ${Date.now() - startTime}ms`);

  // ── Deduplication: keep best signal path per person ───────────────────────
  const dedupedMap = new Map<string, RawDiscovery[]>();
  for (const discovery of allRaw.slice(0, MAX_RAW_DISCOVERIES)) {
    const login = discovery.login.toLowerCase();
    if (!dedupedMap.has(login)) {
      dedupedMap.set(login, []);
    }
    dedupedMap.get(login)!.push(discovery);
  }

  // Sort each person's discoveries by strategy weight (descending)
  const dedupedCandidates = [...dedupedMap.entries()].map(([login, discoveries]) => {
    const sorted = discoveries.sort(
      (a, b) => STRATEGY_WEIGHTS[b.strategy] - STRATEGY_WEIGHTS[a.strategy]
    );
    return {
      login,
      primaryDiscovery: sorted[0],
      allDiscoveries: sorted,
      // Composite signal score: primary + bonus for multi-strategy matches
      signalScore: computeSignalScore(sorted),
    };
  });

  // Sort by signal score — highest first
  dedupedCandidates.sort((a, b) => b.signalScore - a.signalScore);

  console.log(`[Discovery] ${dedupedCandidates.length} unique candidates after dedup`);

  // ── Enrichment + Bot Filtering (in parallel, capped) ─────────────────────
  // Enrich top N candidates with full profile + repos, then run bot detection
  const toEnrich = dedupedCandidates.slice(0, MAX_ENRICHED * 2); // Enrich more than needed, filter down

  const enriched = await Promise.allSettled(
    toEnrich.map(async ({ login, primaryDiscovery, allDiscoveries, signalScore }) => {
      try {
        const [user, repos] = await Promise.all([
          getGitHubUser(login),
          getUserRepos(login, 20),
        ]);

        // Quick filter before expensive bot detection
        if (user.public_repos < MIN_PUBLIC_REPOS) return null;

        const botResult = await detectBot(user, repos);

        if (botResult.isBot) {
          console.log(`[Discovery] Bot filtered: ${login} (${botResult.verdict})`);
          return null;
        }

        return {
          user,
          repos,
          primaryDiscovery,
          allDiscoveries,
          botResult,
          signalScore,
          whyOverlooked: buildWhyOverlooked(primaryDiscovery, allDiscoveries),
        } satisfies DiscoveredCandidate;
      } catch (err) {
        console.warn(`[Discovery] Failed to enrich ${login}:`, err);
        return null;
      }
    })
  );

  const verified: DiscoveredCandidate[] = enriched
    .filter((r): r is PromiseFulfilledResult<DiscoveredCandidate | null> =>
      r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value!)
    .slice(0, MAX_ENRICHED);

  console.log(
    `[Discovery] ${verified.length} candidates verified after bot filter ` +
    `(${Date.now() - startTime}ms total)`
  );

  // Log strategy breakdown
  const strategyBreakdown = verified.reduce<Record<string, number>>((acc, c) => {
    const s = c.primaryDiscovery.strategy;
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  console.log("[Discovery] Strategy breakdown:", strategyBreakdown);

  return verified;
}

// ─── Signal Scorer ────────────────────────────────────────────────────────────
// Multi-strategy confirmation is a strong signal:
// If 3 different strategies all independently found the same person,
// that's much stronger than any single strategy finding them.

function computeSignalScore(discoveries: RawDiscovery[]): number {
  if (discoveries.length === 0) return 0;

  // Primary strategy weight (0–9)
  const primaryWeight = STRATEGY_WEIGHTS[discoveries[0].strategy];

  // Bonus for each additional strategy that confirmed them (diminishing returns)
  const confirmationBonus = discoveries
    .slice(1)
    .reduce((acc, d, i) => acc + STRATEGY_WEIGHTS[d.strategy] * Math.pow(0.5, i + 1), 0);

  // Bonus for raw signal strength
  const signalBonus = discoveries[0].signalStrength * 0.3;

  return Math.min(10, primaryWeight + confirmationBonus * 0.3 + signalBonus);
}

// ─── Why Overlooked Builder ───────────────────────────────────────────────────
// Generates the human-readable explanation of why conventional search misses them.

function buildWhyOverlooked(
  primary: RawDiscovery,
  all: RawDiscovery[]
): string {
  const strategyMessages: Record<StrategyName, string> = {
    package_ecosystem:
      "Published a library others can use — package authors are never surfaced by resume or LinkedIn search.",
    contributor_network:
      "Silent contributor to key projects — their expertise lives in others' codebases, not their own profile.",
    hidden_gem:
      "Built something real but not famous yet — low star count hides a substantive, quality project.",
    topic_graph:
      "Self-tagged their work with precise technical topics — only visible to those who know what to look for.",
    fork_evolution:
      "Extended existing work in a new direction — forks are universally dismissed by every recruiting tool.",
    domain_longevity:
      "Has been quietly working in this domain for years — sustained focus is invisible to trending-based tools.",
    cross_domain_transfer:
      "Brings expertise from adjacent fields — appears 'scattered' to keyword tools, but that's their superpower.",
    issue_intelligence:
      "Demonstrates expertise through how they reason about problems, not just what they build.",
    direct_search:
      "Low follower count and no LinkedIn presence makes them invisible to most recruiting pipelines.",
  };

  const base = strategyMessages[primary.strategy];

  // If found by multiple strategies, add that context
  if (all.length > 1) {
    const otherStrategies = all
      .slice(1)
      .map((d) => d.strategy.replace(/_/g, " "))
      .join(", ");
    return `${base} Also independently found via: ${otherStrategies}.`;
  }

  return base;
}
