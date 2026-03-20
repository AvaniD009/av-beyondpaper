/**
 * TRENDING REPO CONTRIBUTION SCORER
 * ─────────────────────────────────────────────────────────────────────────────
 * Finds the currently trending repositories in the query's niche and checks
 * whether each candidate has contributed to them.
 *
 * Why this matters:
 *   Contributing to a trending repo is the strongest real-time signal that
 *   a person is ACTIVELY engaged with the bleeding edge of a domain — not
 *   just someone who learned it years ago and stopped.
 *
 *   It also signals:
 *   - They track the ecosystem (they found the repo while it was rising)
 *   - They engage with momentum (they contributed while it matters)
 *   - They're recognized by maintainers (merged PRs = peer validation)
 *   - Their skills are current (trending = recently relevant)
 *
 * Trending sources (in order of priority):
 *   1. GitHub Trending API (unofficial but reliable scrape)
 *   2. GitHub Search: repos sorted by recently-gained stars
 *   3. GitHub Search: repos created/updated recently with high velocity
 *   4. Curated ecosystem signals (known "hot" repos per domain)
 *
 * Contribution types checked (richness ladder):
 *   Merged PR      → strongest: maintainers accepted their work
 *   Open PR        → active engagement with the codebase
 *   Commit         → direct push access or was merged
 *   Issue (detailed) → engaged with the project's problems
 *   Issue (any)    → at minimum, tracks and uses the project
 *   Star only      → weakest: awareness, not contribution
 */

import { octokit } from "@/lib/github/client";
import { cacheGet, cacheSet } from "@/lib/cache/redis";
import type { QueryAnalysis } from "./query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrendingRepo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  /** Stars gained in the last 7 days (velocity signal) */
  weeklyStarGrowth: number;
  topics: string[];
  /** Why this repo is considered trending for this niche */
  trendingReason: string;
  /** How niche-relevant is this repo (0–10) */
  nicheRelevance: number;
  /** Is this a major/foundation repo in the ecosystem? */
  isFoundational: boolean;
}

export type ContributionType =
  | "merged_pr"
  | "open_pr"
  | "commit"
  | "detailed_issue"
  | "issue"
  | "review"
  | "none";

export interface RepoContribution {
  repo: TrendingRepo;
  contributionType: ContributionType;
  /** Number of merged PRs if type is merged_pr */
  mergedPRCount: number;
  /** Number of commits if type is commit */
  commitCount: number;
  /** The most recent contribution date */
  mostRecentDate: string | null;
  /** Link to their most significant contribution */
  contributionUrl: string | null;
  /** Is this contribution recent (last 6 months)? */
  isRecent: boolean;
}

export interface TrendingContributionResult {
  username: string;
  /** Trending repos found for this query */
  trendingRepos: TrendingRepo[];
  /** This candidate's contributions to those repos */
  contributions: RepoContribution[];
  /** How many trending repos they've contributed to */
  trendingReposContributed: number;
  /** Their highest-quality contribution type */
  bestContributionType: ContributionType;
  /** Composite score 0–100 */
  trendingScore: number;
  /** Human-readable summary */
  summary: string;
  /** Specific repos and what they did */
  highlights: string[];
}

// ─── Contribution Type Weights ────────────────────────────────────────────────
// Used to score contribution richness

const CONTRIBUTION_WEIGHTS: Record<ContributionType, number> = {
  merged_pr: 100,
  open_pr: 70,
  commit: 80,
  review: 60,
  detailed_issue: 40,
  issue: 20,
  none: 0,
};

// ─── Trending Repo Fetcher ────────────────────────────────────────────────────

const TRENDING_CACHE_TTL = 60 * 60 * 3; // 3h — trending changes daily, not hourly

/**
 * Fetches trending repos for the query's niche using three complementary methods.
 * Results are cached for 3h to avoid hammering the API.
 */
export async function fetchTrendingRepos(
  query: QueryAnalysis,
  limit = 12
): Promise<TrendingRepo[]> {
  const cacheKey = `trending:${query.domains.slice(0, 2).sort().join(",").toLowerCase().replace(/\s+/g, "-")}`;

  // Try cache first
  const cached = await cacheGet<TrendingRepo[]>(cacheKey);
  if (cached) {
    console.log(`[Trending] Cache HIT: ${cacheKey}`);
    return cached;
  }

  const repos = new Map<string, TrendingRepo>();

  // ── Method 1: GitHub Trending page scrape ─────────────────────────────────
  // GitHub's trending page is public HTML — we parse it to get real trending data
  await fetchFromGitHubTrending(query, repos);

  // ── Method 2: Recent high-velocity repos via search API ───────────────────
  await fetchHighVelocityRepos(query, repos, limit);

  // ── Method 3: Foundational ecosystem repos (always relevant) ──────────────
  await fetchFoundationalRepos(query, repos);

  const results = [...repos.values()]
    .sort((a, b) => b.nicheRelevance * b.weeklyStarGrowth - a.nicheRelevance * a.weeklyStarGrowth)
    .slice(0, limit);

  await cacheSet(cacheKey, results, TRENDING_CACHE_TTL);
  return results;
}

// ─── Method 1: GitHub Trending Page ─────────────────────────────────────────
// Scrape github.com/trending?l=<language>&since=weekly

async function fetchFromGitHubTrending(
  query: QueryAnalysis,
  repos: Map<string, TrendingRepo>
): Promise<void> {
  const languages = query.languages.slice(0, 2);
  const urls = [
    "https://github.com/trending?since=weekly",
    ...languages.map((l) => `https://github.com/trending/${encodeURIComponent(l.toLowerCase())}?since=weekly`),
  ];

  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; skillsync-bot/1.0)",
            "Accept": "text/html",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return;

        const html = await resp.text();
        const parsed = parseGitHubTrendingHTML(html, query);
        for (const repo of parsed) {
          if (!repos.has(repo.fullName)) repos.set(repo.fullName, repo);
        }
      } catch { /* trending page may be unavailable */ }
    })
  );
}

function parseGitHubTrendingHTML(html: string, query: QueryAnalysis): TrendingRepo[] {
  const results: TrendingRepo[] = [];

  // Extract repo entries from trending page HTML
  // Pattern: <h2 class="h3 lh-condensed"><a href="/owner/repo">
  const repoPattern = /href="\/([^/]+)\/([^/"]+)"[^>]*>\s*\n?\s*([^<]+)/g;
  const starsPattern = /(\d[\d,]*)\s*stars this week/gi;

  const repoMatches = [...html.matchAll(repoPattern)];
  const starMatches = [...html.matchAll(starsPattern)];

  const niche = [
    ...query.requiredSkills,
    ...query.domains.flatMap((d) => d.split(" ")),
    ...query.dbKeywords.slice(0, 5),
  ].map((k) => k.toLowerCase());

  repoMatches.slice(0, 25).forEach((match, i) => {
    const owner = match[1];
    const name = match[2];
    const title = match[3]?.trim() ?? "";

    if (!owner || !name || owner === "trending") return;

    const weeklyGrowth = starMatches[i]
      ? parseInt(starMatches[i][1].replace(/,/g, ""), 10)
      : 0;

    // Check if this trending repo is relevant to our niche
    const repoText = `${owner} ${name} ${title}`.toLowerCase();
    const relevanceHits = niche.filter((kw) => repoText.includes(kw)).length;
    if (relevanceHits === 0) return; // Not relevant to niche

    results.push({
      owner,
      name,
      fullName: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`,
      description: title || null,
      language: query.languages[0] ?? null,
      stars: 0,   // not easily parseable from trending HTML
      weeklyStarGrowth: weeklyGrowth,
      topics: [],
      trendingReason: `Trending on GitHub (${weeklyGrowth > 0 ? `+${weeklyGrowth} stars this week` : "this week"})`,
      nicheRelevance: Math.min(10, relevanceHits * 3),
      isFoundational: false,
    });
  });

  return results;
}

// ─── Method 2: High-Velocity Repos via Search API ────────────────────────────
// "Recently created repos that are gaining stars fast" = trending signal

async function fetchHighVelocityRepos(
  query: QueryAnalysis,
  repos: Map<string, TrendingRepo>,
  limit: number
): Promise<void> {
  // Repos with >50 stars created in last 30 days = rapidly trending
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split("T")[0];

  const queries = [
    // Recent high-star repos in the specific niche
    ...query.githubSearchTerms.slice(0, 2).map(
      (t) => `${t} created:>${since} stars:>30`
    ),
    // Repos with niche topics that recently got traction
    ...query.domains.slice(0, 1).map(
      (d) => `${d.split(" ")[0]} pushed:>${since} stars:>50`
    ),
  ];

  await Promise.allSettled(
    queries.slice(0, 3).map(async (q) => {
      try {
        const { data } = await octokit.search.repositories({
          q,
          sort: "stars",
          order: "desc",
          per_page: 6,
        });

        const niche = [
          ...query.requiredSkills,
          ...query.domains.flatMap((d) => d.split(" ")),
        ].map((k) => k.toLowerCase());

        for (const repo of data.items) {
          if (!repo.owner) continue;
          if (repos.has(repo.full_name)) continue;

          const repoText = [repo.name, repo.description ?? "", (repo.topics ?? []).join(" ")].join(" ").toLowerCase();
          const relevanceHits = niche.filter((kw) => repoText.includes(kw)).length;

          repos.set(repo.full_name, {
            owner: repo.owner.login,
            name: repo.name,
            fullName: repo.full_name,
            url: repo.html_url,
            description: repo.description ?? null,
            language: repo.language ?? null,
            stars: repo.stargazers_count,
            weeklyStarGrowth: 0, // not available from search
            topics: repo.topics ?? [],
            trendingReason: `${repo.stargazers_count} stars, created ${repo.created_at?.slice(0, 10)} — rapidly rising`,
            nicheRelevance: Math.min(10, 3 + relevanceHits * 2),
            isFoundational: repo.stargazers_count > 5000,
          });
        }
      } catch { /* continue */ }
    })
  );
}

// ─── Method 3: Foundational Ecosystem Repos ──────────────────────────────────
// Well-known "anchor" repos in each domain — contributing here is always a signal

const DOMAIN_ANCHOR_REPOS: Record<string, string[]> = {
  "nlp": ["huggingface/transformers", "explosion/spacy", "stanfordnlp/stanza", "allenai/allennlp"],
  "machine learning": ["pytorch/pytorch", "tensorflow/tensorflow", "google/jax", "scikit-learn/scikit-learn"],
  "llm": ["huggingface/transformers", "ggerganov/llama.cpp", "lm-sys/FastChat", "vllm-project/vllm"],
  "rust": ["rust-lang/rust", "tokio-rs/tokio", "serde-rs/serde", "dtolnay/anyhow"],
  "webassembly": ["bytecodealliance/wasmtime", "emscripten-core/emscripten", "wasmerio/wasmer"],
  "kubernetes": ["kubernetes/kubernetes", "helm/helm", "fluxcd/flux2", "argoproj/argo-cd"],
  "compiler": ["llvm/llvm-project", "nickel-lang/nickel", "rust-lang/rust"],
  "database": ["duckdb/duckdb", "apache/arrow", "ClickHouse/ClickHouse", "questdb/questdb"],
  "distributed systems": ["apache/kafka", "etcd-io/etcd", "tikv/tikv"],
  "networking": ["cloudflare/quiche", "iovisor/bcc", "cilium/cilium"],
  "robotics": ["ros2/rclcpp", "PX4/PX4-Autopilot"],
  "gpu": ["NVIDIA/cuda-samples", "ROCm/ROCm"],
  "inference": ["vllm-project/vllm", "triton-inference-server/server", "ggerganov/llama.cpp"],
  "embeddings": ["facebookresearch/faiss", "qdrant/qdrant", "chroma-core/chroma"],
};

async function fetchFoundationalRepos(
  query: QueryAnalysis,
  repos: Map<string, TrendingRepo>
): Promise<void> {
  const anchors = new Set<string>();

  for (const domain of query.domains) {
    const lower = domain.toLowerCase();
    for (const [key, repoList] of Object.entries(DOMAIN_ANCHOR_REPOS)) {
      if (lower.includes(key) || key.includes(lower.split(" ")[0])) {
        repoList.forEach((r) => anchors.add(r));
      }
    }
  }

  // Also check requiredSkills against anchor map
  for (const skill of query.requiredSkills) {
    const lower = skill.toLowerCase();
    for (const [key, repoList] of Object.entries(DOMAIN_ANCHOR_REPOS)) {
      if (lower.includes(key) || key.includes(lower)) {
        repoList.forEach((r) => anchors.add(r));
      }
    }
  }

  await Promise.allSettled(
    [...anchors].slice(0, 8).map(async (fullName) => {
      if (repos.has(fullName)) return;
      try {
        const [owner, name] = fullName.split("/");
        const { data } = await octokit.repos.get({ owner, repo: name });
        repos.set(fullName, {
          owner,
          name,
          fullName,
          url: data.html_url,
          description: data.description ?? null,
          language: data.language ?? null,
          stars: data.stargazers_count,
          weeklyStarGrowth: 0,
          topics: data.topics ?? [],
          trendingReason: `Foundational ecosystem repo (${data.stargazers_count.toLocaleString()} stars)`,
          nicheRelevance: 9,
          isFoundational: true,
        });
      } catch { /* repo may not exist */ }
    })
  );
}

// ─── Contribution Checker ─────────────────────────────────────────────────────

/**
 * Checks a single candidate's contributions to a list of trending repos.
 * Uses multiple API calls in parallel, with rate-limit awareness.
 */
async function checkContributions(
  username: string,
  trendingRepos: TrendingRepo[]
): Promise<RepoContribution[]> {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const results = await Promise.allSettled(
    trendingRepos.map(async (repo): Promise<RepoContribution> => {
      const base: RepoContribution = {
        repo,
        contributionType: "none",
        mergedPRCount: 0,
        commitCount: 0,
        mostRecentDate: null,
        contributionUrl: null,
        isRecent: false,
      };

      try {
        // Check 1: merged PRs (strongest signal — search issues API)
        const { data: prs } = await octokit.search.issuesAndPullRequests({
          q: `repo:${repo.fullName} author:${username} type:pr is:merged`,
          per_page: 5,
          sort: "created",
          order: "desc",
        });

        if (prs.total_count > 0) {
          const mostRecent = prs.items[0];
          return {
            ...base,
            contributionType: "merged_pr",
            mergedPRCount: prs.total_count,
            mostRecentDate: mostRecent.created_at,
            contributionUrl: mostRecent.html_url,
            isRecent: new Date(mostRecent.created_at) > sixMonthsAgo,
          };
        }

        // Check 2: open PRs
        const { data: openPRs } = await octokit.search.issuesAndPullRequests({
          q: `repo:${repo.fullName} author:${username} type:pr is:open`,
          per_page: 3,
        });

        if (openPRs.total_count > 0) {
          const mostRecent = openPRs.items[0];
          return {
            ...base,
            contributionType: "open_pr",
            mostRecentDate: mostRecent.created_at,
            contributionUrl: mostRecent.html_url,
            isRecent: new Date(mostRecent.created_at) > sixMonthsAgo,
          };
        }

        // Check 3: commits
        const { data: commits } = await octokit.repos.listCommits({
          owner: repo.owner,
          repo: repo.name,
          author: username,
          per_page: 5,
        });

        if (commits.length > 0) {
          const mostRecent = commits[0];
          const date = mostRecent.commit.author?.date ?? null;
          return {
            ...base,
            contributionType: "commit",
            commitCount: commits.length,
            mostRecentDate: date,
            contributionUrl: mostRecent.html_url,
            isRecent: date ? new Date(date) > sixMonthsAgo : false,
          };
        }

        // Check 4: issues filed (shows engagement, even if no code)
        const { data: issues } = await octokit.search.issuesAndPullRequests({
          q: `repo:${repo.fullName} author:${username} type:issue`,
          per_page: 3,
          sort: "created",
          order: "desc",
        });

        if (issues.total_count > 0) {
          const mostRecent = issues.items[0];
          const isDetailed = (mostRecent.body?.length ?? 0) > 200;
          return {
            ...base,
            contributionType: isDetailed ? "detailed_issue" : "issue",
            mostRecentDate: mostRecent.created_at,
            contributionUrl: mostRecent.html_url,
            isRecent: new Date(mostRecent.created_at) > sixMonthsAgo,
          };
        }
      } catch { /* API error — return no contribution */ }

      return base;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<RepoContribution> => r.status === "fulfilled")
    .map((r) => r.value);
}

// ─── Score Calculator ─────────────────────────────────────────────────────────

function computeTrendingScore(contributions: RepoContribution[], repos: TrendingRepo[]): number {
  if (contributions.length === 0 || repos.length === 0) return 0;

  let score = 0;

  for (const contrib of contributions) {
    if (contrib.contributionType === "none") continue;

    const typeScore = CONTRIBUTION_WEIGHTS[contrib.contributionType];
    const recencyBonus = contrib.isRecent ? 1.3 : 0.7;
    const nicheBonus = contrib.repo.nicheRelevance / 10;
    const foundationalBonus = contrib.repo.isFoundational ? 1.2 : 1.0;
    const volumeBonus = contrib.contributionType === "merged_pr"
      ? Math.min(1.5, 1 + contrib.mergedPRCount * 0.1)
      : contrib.contributionType === "commit"
      ? Math.min(1.4, 1 + contrib.commitCount * 0.05)
      : 1.0;

    score += typeScore * recencyBonus * nicheBonus * foundationalBonus * volumeBonus;
  }

  // Normalize: max realistic score ≈ 400 (4 merged PRs in foundational repos)
  return Math.min(100, Math.round(score / 4));
}

function buildSummaryAndHighlights(
  contributions: RepoContribution[]
): { summary: string; highlights: string[] } {
  const active = contributions.filter((c) => c.contributionType !== "none");

  if (active.length === 0) {
    return {
      summary: "No contributions to trending niche repositories found",
      highlights: [],
    };
  }

  const highlights = active.map((c) => {
    const recency = c.isRecent ? "recently" : "previously";
    const repoDisplay = c.repo.fullName;

    switch (c.contributionType) {
      case "merged_pr":
        return `${c.mergedPRCount} merged PR${c.mergedPRCount > 1 ? "s" : ""} in **${repoDisplay}** (${recency}) — maintainers accepted their work`;
      case "open_pr":
        return `Open PR in **${repoDisplay}** (${recency}) — actively engaged with the codebase`;
      case "commit":
        return `${c.commitCount} commit${c.commitCount > 1 ? "s" : ""} to **${repoDisplay}** (${recency})`;
      case "detailed_issue":
        return `Filed detailed issue in **${repoDisplay}** (${recency}) — deep engagement with the project's problems`;
      case "issue":
        return `Opened issue in **${repoDisplay}** (${recency})`;
      default:
        return `Engaged with **${repoDisplay}**`;
    }
  });

  const mergedCount = active.filter((c) => c.contributionType === "merged_pr").length;
  const recentCount = active.filter((c) => c.isRecent).length;

  const summary = mergedCount > 0
    ? `Has merged PRs in ${mergedCount} trending niche repo${mergedCount > 1 ? "s" : ""} — actively contributing to the ecosystem's most important projects`
    : recentCount > 0
    ? `Actively contributing to ${recentCount} trending niche repo${recentCount > 1 ? "s" : ""} in the last 6 months`
    : `Has contributed to ${active.length} repos in this niche's ecosystem`;

  return { summary, highlights };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * scoreTrendingContributions — fetches trending repos for the query's niche
 * and scores each candidate's contributions to them.
 *
 * Designed to be called ONCE per search (trending repos) and then checked
 * per-candidate — avoids refetching the same trending list for every candidate.
 */
export async function scoreTrendingContributions(
  username: string,
  query: QueryAnalysis,
  preloadedTrendingRepos?: TrendingRepo[]
): Promise<TrendingContributionResult> {
  // Use pre-loaded repos if provided (batch optimization), else fetch
  const trendingRepos = preloadedTrendingRepos ?? await fetchTrendingRepos(query);

  if (trendingRepos.length === 0) {
    return {
      username,
      trendingRepos: [],
      contributions: [],
      trendingReposContributed: 0,
      bestContributionType: "none",
      trendingScore: 0,
      summary: "No trending repos identified for this niche",
      highlights: [],
    };
  }

  const contributions = await checkContributions(username, trendingRepos);
  const activeContributions = contributions.filter((c) => c.contributionType !== "none");

  const bestType = activeContributions
    .sort((a, b) => CONTRIBUTION_WEIGHTS[b.contributionType] - CONTRIBUTION_WEIGHTS[a.contributionType])[0]
    ?.contributionType ?? "none";

  const trendingScore = computeTrendingScore(contributions, trendingRepos);
  const { summary, highlights } = buildSummaryAndHighlights(activeContributions);

  return {
    username,
    trendingRepos,
    contributions,
    trendingReposContributed: activeContributions.length,
    bestContributionType: bestType,
    trendingScore,
    summary,
    highlights,
  };
}

/**
 * fetchTrendingReposOnce — call this once before ranking to pre-load the
 * trending repo list. Pass the result into scoreTrendingContributions for
 * each candidate to avoid redundant API calls.
 */
export { fetchTrendingRepos as fetchTrendingReposOnce };
