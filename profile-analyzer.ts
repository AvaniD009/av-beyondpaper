/**
 * AGENT 3 — DEEP PROFILE ANALYZER
 * ─────────────────────────────────────────────────────────────────────────────
 * The most expensive and most valuable agent in the pipeline.
 * Performs a thorough investigation of each candidate — cached aggressively.
 *
 * Sub-agents it orchestrates:
 *   3a. SocialDiscoverer     — finds GitHub, LinkedIn, site, linktree, Instagram
 *   3b. DeepGitHubFetcher    — commits, PRs, issues, gists, pinned repos, file trees
 *   3c. NicheCommitAnalyzer  — query-specific commit depth analysis
 *   3d. CodeQualityEvaluator — samples real code, evaluates against standards
 *   3e. ProfileSynthesizer   — Claude deep-dives everything into a unified profile
 *   3f. NicheFitEvaluator    — answers: does this person meet the querier's need?
 *
 * Cache architecture:
 *   Layer 1: Upstash Redis      — 24h TTL, sub-millisecond reads
 *   Layer 2: Turso DB           — permanent, survives Redis eviction
 *   Layer 3: Fresh fetch        — only when both caches miss
 *
 * Cache key strategy:
 *   - Base profile:   analysis:{username}          — 24h (query-independent)
 *   - Niche fit:      niche:{username}:{queryHash}  — 6h  (query-specific)
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "@/lib/agents/bias-free-evaluator";
import { discoverSocialPresence, type SocialPresence } from "@/lib/github/social-discoverer";
import {
  getPinnedRepos,
  getCommitSamples,
  getPullRequestSamples,
  getIssueSamples,
  getGistSamples,
  getRepoStructure,
  analyzeNicheCommits,
  getContributionSignals,
  type DeepGitHubData,
} from "@/lib/github/deep-fetcher";
import { evaluateCodeQuality, type CodeQualityReport } from "@/lib/github/code-quality";
import { evaluateNicheFit, type NicheFitResult } from "@/lib/agents/niche-fit-evaluator";
import {
  getTopReposWithREADME,
  getLanguageStats,
  type GitHubUser,
  type GitHubRepo,
} from "@/lib/github/client";
import { upsertProfile, upsertAnalysis, getAnalysis } from "@/lib/db/client";
import { cacheGet, cacheSet, CacheKey, TTL } from "@/lib/cache/redis";
import type { QueryAnalysis } from "@/lib/agents/query-analyzer";
import type { DBAnalysis, SkillEntry, ProjectEntry } from "@/lib/db/client";

// ─── Output Type ──────────────────────────────────────────────────────────────

export interface DeepProfileAnalysis {
  // ── Identity ──────────────────────────────────────────────────────────────
  username: string;
  name: string | null;
  avatar_url: string;
  github_url: string;
  bio: string | null;
  location: string | null;
  company: string | null;

  // ── Social presence ───────────────────────────────────────────────────────
  socialPresence: SocialPresence;

  // ── Core skill profile ────────────────────────────────────────────────────
  headline: string;
  domains: string[];
  skills: SkillEntry[];
  strengths: string[];
  projects: ProjectEntry[];
  languages: Record<string, number>;

  // ── Depth scores ──────────────────────────────────────────────────────────
  expertiseScore: number;        // Bias-free depth signal (1–100)
  codeQualityScore: number;      // From real sampled files (1–10)
  isProductionGrade: boolean;

  // ── Query-specific niche fit ───────────────────────────────────────────────
  nicheFit: NicheFitResult | null;

  // ── GitHub depth signals ──────────────────────────────────────────────────
  deepGithub: {
    pinnedRepos: GitHubRepo[];
    commitMessageQuality: "architectural" | "descriptive" | "adequate" | "terse";
    totalNicheCommits: number;
    recentNicheCommits: number;
    nicheRepos: string[];
    longestContributionStreak: number;
    hasPublishedPackage: boolean;
    contributionConsistency: "daily" | "regular" | "occasional" | "sporadic";
  };

  // ── Code quality report ───────────────────────────────────────────────────
  codeQuality: CodeQualityReport;

  // ── Profile synthesis ─────────────────────────────────────────────────────
  possibilities: string[];           // what they COULD do — not "are they good?"
  uniqueContribution: string;        // what makes them different from 1000 others
  technicalFingerprint: string[];    // patterns only they exhibit

  // ── Metadata ─────────────────────────────────────────────────────────────
  searchableText: string;
  analyzedAt: string;
  cacheSource: "redis" | "db" | "fresh";
}

// ─── Niche cache key ──────────────────────────────────────────────────────────

function nicheKey(username: string, query: QueryAnalysis): string {
  const hash = Buffer.from(
    [...query.requiredSkills].sort().join(",") +
    [...query.domains].sort().join(",")
  ).toString("base64").slice(0, 24);
  return `niche:${username.toLowerCase()}:${hash}`;
}

// ─── Sub-Agent 3e: Profile Synthesizer ───────────────────────────────────────

interface SynthesisOutput {
  headline: string;
  domains: string[];
  skills: SkillEntry[];
  strengths: string[];
  projects: Array<{ name: string; description: string; impact: string; technologies: string[]; stars?: number }>;
  possibilities: string[];
  uniqueContribution: string;
  technicalFingerprint: string[];
  expertiseScore: number;
  commitMessageQuality: "architectural" | "descriptive" | "adequate" | "terse";
  contributionConsistency: "daily" | "regular" | "occasional" | "sporadic";
}

async function synthesizeProfile(
  user: GitHubUser,
  repos: GitHubRepo[],
  deepData: DeepGitHubData,
  social: SocialPresence,
  codeQuality: CodeQualityReport,
  langStats: Record<string, number>
): Promise<SynthesisOutput> {

  const repoSection = repos.slice(0, 8).map((r) =>
    [
      `### ${r.name}`,
      r.description ? `Description: ${r.description}` : null,
      `Language: ${r.language ?? "unknown"}`,
      r.topics.length ? `Topics: ${r.topics.slice(0, 8).join(", ")}` : null,
      r.readme_excerpt ? `README:\n${r.readme_excerpt.slice(0, 600)}` : null,
    ].filter(Boolean).join("\n")
  ).join("\n\n---\n\n");

  const commitSection = deepData.commitSamples.slice(0, 10).map((c) => {
    const body = c.messageBody ? `\n  → ${c.messageBody.slice(0, 120)}` : "";
    const diff = c.diffSnippet ? `\n  Code:\n${c.diffSnippet.slice(0, 200)}` : "";
    return `[${c.repo}] ${c.message}${body}${diff}`;
  }).join("\n\n") || "No commit samples.";

  const prSection = deepData.prSamples.slice(0, 5).map((pr) =>
    `${pr.merged ? "[MERGED]" : `[${pr.state}]`} ${pr.repo}: ${pr.title}${pr.body ? `\n  ${pr.body.slice(0, 180)}` : ""}`
  ).join("\n\n") || "No PR history.";

  const issueSection = deepData.issueSamples.slice(0, 5).map((i) =>
    `[${i.repo}] ${i.title}${i.body ? `\n  ${i.body.slice(0, 150)}` : ""}`
  ).join("\n\n") || "No issue history.";

  const gistSection = deepData.gistSamples.slice(0, 3).map((g) =>
    `${g.description ?? "Untitled"} (${g.files.join(", ")})${g.content ? `\n  ${g.content.slice(0, 180)}` : ""}`
  ).join("\n") || "No gists.";

  const pinnedSection = deepData.pinnedRepos.length > 0
    ? "PINNED REPOS (curated by the engineer):\n" +
      deepData.pinnedRepos.map((r) => `  - ${r.name}: ${r.description ?? "no description"}`).join("\n")
    : "";

  const socialLinks = [
    social.linkedin ? `LinkedIn: ${social.linkedin.url}` : null,
    social.personalWebsite ? `Website: ${social.personalWebsite.url}` : null,
    social.blog ? `Blog: ${social.blog.url}` : null,
    social.hasWritingPresence ? "Has public writing presence" : null,
  ].filter(Boolean).join("\n");

  return callClaudeJSON<SynthesisOutput>(
    `Deep profile synthesis for GitHub engineer.
Goal: understand their POSSIBILITIES and technical fingerprint — not score them.

PROFILE:
Name: ${user.name ?? "not provided"} | Bio: ${user.bio ?? "none"} | Company: ${user.company ?? "none"}
Languages: ${Object.entries(langStats).map(([l, p]) => `${l} ${p}%`).join(", ")}

TOP REPOS:
${repoSection}

${pinnedSection}

COMMITS (how they think when coding):
${commitSection}

PULL REQUESTS (what they propose):
${prSection}

ISSUES (how they reason about problems):
${issueSection}

GISTS (domain intuition):
${gistSection}

CODE QUALITY:
Score: ${codeQuality.overallScore}/10 | Production grade: ${codeQuality.isProductionGrade}
Green flags: ${codeQuality.greenFlags.join("; ") || "none"}
Red flags: ${codeQuality.redFlags.join("; ") || "none"}
Domain patterns: ${codeQuality.domainPatternsFound.join(", ") || "none"}

SOCIAL PRESENCE:
${socialLinks || "None found."}

CONTRIBUTION RHYTHM:
Active weeks (last 6mo): ${deepData.contributionSignals.activeWeeksLast6Months}/26
Longest streak: ${deepData.contributionSignals.longestStreak} weeks
Avg weekly: ${deepData.contributionSignals.averageWeeklyCommits} commits

Return JSON:
{
  "headline": "one compelling sentence, unique to them, max 120 chars, no clichés",
  "domains": ["2-4 specific domains they actually work in"],
  "skills": [{ "name": "...", "level": "expert|proficient|familiar", "evidence": "cite specific repo/commit/code" }],
  "strengths": ["4-6 statements starting with a verb, grounded in actual evidence"],
  "projects": [{ "name": "...", "description": "...", "impact": "...", "technologies": ["..."] }],
  "possibilities": ["3-5 'Could...' statements about untapped potential"],
  "uniqueContribution": "what makes THIS engineer different from 1000 others with the same stack",
  "technicalFingerprint": ["3-5 specific patterns that identify their work"],
  "expertiseScore": <1-100, depth of problem-solving and craft — NOT fame>,
  "commitMessageQuality": "architectural|descriptive|adequate|terse",
  "contributionConsistency": "daily|regular|occasional|sporadic"
}`,
    { system: BIAS_FREE_SYSTEM_PROMPT, maxTokens: 2500 }
  );
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

export async function analyzeProfile(
  user: GitHubUser,
  repos: GitHubRepo[],
  query: QueryAnalysis,
  forceRefresh = false
): Promise<DeepProfileAnalysis> {
  const username = user.login.toLowerCase();

  // ── Layer 1: Redis ─────────────────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = await cacheGet<DeepProfileAnalysis>(CacheKey.analysis(username));
    if (cached) {
      console.log(`[Agent3] Cache HIT (Redis): ${username}`);
      cached.nicheFit ??= await runNicheFit(cached, repos, query, username);
      cached.cacheSource = "redis";
      return cached;
    }

    // ── Layer 2: DB ──────────────────────────────────────────────────────────
    const dbHit = await getAnalysis(username);
    if (dbHit) {
      console.log(`[Agent3] Cache HIT (DB): ${username}`);
      const profile = dbToProfile(dbHit, user);
      profile.nicheFit = await runNicheFit(profile, repos, query, username);
      await cacheSet(CacheKey.analysis(username), profile, TTL.ANALYSIS);
      profile.cacheSource = "db";
      return profile;
    }
  }

  // ── Layer 3: Full fresh analysis ───────────────────────────────────────────
  console.log(`[Agent3] Fresh analysis: ${username}`);
  const t0 = Date.now();

  // Fan-out all data fetches in parallel
  const [
    topReposResult,
    langStatsResult,
    socialResult,
    pinnedResult,
    commitsResult,
    prsResult,
    issuesResult,
    gistsResult,
    contributionResult,
  ] = await Promise.allSettled([
    getTopReposWithREADME(username, 10),
    getLanguageStats(username),
    discoverSocialPresence(user),
    getPinnedRepos(username),
    getCommitSamples(username, repos, 25),
    getPullRequestSamples(username, 10),
    getIssueSamples(username, 10),
    getGistSamples(username, 6),
    getContributionSignals(username, repos),
  ]);

  const topRepos = topReposResult.status === "fulfilled" ? topReposResult.value : repos;
  const langStats = langStatsResult.status === "fulfilled" ? langStatsResult.value : {};
  const social = socialResult.status === "fulfilled" ? socialResult.value : emptyPresence(user);

  // Repo structures (top 2, in parallel)
  const structureResults = await Promise.allSettled(
    topRepos.filter((r) => !r.is_fork).slice(0, 2).map((r) => getRepoStructure(username, r.name))
  );
  const repoStructures = structureResults
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<ReturnType<typeof getRepoStructure> extends Promise<infer T> ? T : never>).value);

  // Niche commit analysis + code quality (can run in parallel)
  const nicheKeywords = [...query.requiredSkills, ...query.domains.flatMap((d) => d.split(" "))];
  const [nicheAnalysis, codeQuality] = await Promise.all([
    analyzeNicheCommits(username, nicheKeywords, repos),
    evaluateCodeQuality(topRepos, username, query.domains, query.requiredSkills),
  ]);

  const deepData: DeepGitHubData = {
    username,
    pinnedRepos: pinnedResult.status === "fulfilled" ? pinnedResult.value : [],
    commitSamples: commitsResult.status === "fulfilled" ? commitsResult.value : [],
    prSamples: prsResult.status === "fulfilled" ? prsResult.value : [],
    issueSamples: issuesResult.status === "fulfilled" ? issuesResult.value : [],
    gistSamples: gistsResult.status === "fulfilled" ? gistsResult.value : [],
    repoStructures,
    nicheAnalysis,
    contributionSignals: contributionResult.status === "fulfilled"
      ? contributionResult.value
      : { activeWeeksLast6Months: 0, longestStreak: 0, averageWeeklyCommits: 0 },
  };

  // Claude synthesis
  const synthesis = await synthesizeProfile(user, topRepos, deepData, social, codeQuality, langStats);

  // Niche fit (query-specific)
  const projects: ProjectEntry[] = synthesis.projects.map((p) => ({
    name: p.name,
    url: `https://github.com/${username}/${p.name}`,
    description: p.description,
    impact: p.impact,
    technologies: p.technologies,
    stars: p.stars,
  }));

  const nicheFit = await evaluateNicheFit(query, nicheAnalysis, codeQuality, {
    username,
    headline: synthesis.headline,
    domains: synthesis.domains,
    skills: synthesis.skills,
    projectDescriptions: projects.map((p) => `${p.name}: ${p.description} — ${p.impact}`),
  });

  const searchableText = [
    synthesis.headline,
    synthesis.domains.join(" "),
    synthesis.skills.map((s) => s.name).join(" "),
    synthesis.technicalFingerprint.join(" "),
    synthesis.possibilities.join(" "),
    user.bio ?? "",
    user.name ?? "",
    nicheAnalysis.nicheRepos.join(" "),
  ].join(" ").toLowerCase();

  const profile: DeepProfileAnalysis = {
    username,
    name: user.name,
    avatar_url: user.avatar_url,
    github_url: user.html_url,
    bio: user.bio,
    location: user.location,
    company: user.company,
    socialPresence: social,
    headline: synthesis.headline,
    domains: synthesis.domains,
    skills: synthesis.skills,
    strengths: synthesis.strengths,
    projects,
    languages: langStats,
    expertiseScore: Math.min(100, Math.max(1, synthesis.expertiseScore)),
    codeQualityScore: codeQuality.overallScore,
    isProductionGrade: codeQuality.isProductionGrade,
    nicheFit,
    deepGithub: {
      pinnedRepos: deepData.pinnedRepos,
      commitMessageQuality: synthesis.commitMessageQuality,
      totalNicheCommits: nicheAnalysis.totalNicheCommits,
      recentNicheCommits: nicheAnalysis.recentNicheCommits,
      nicheRepos: nicheAnalysis.nicheRepos,
      longestContributionStreak: deepData.contributionSignals.longestStreak,
      hasPublishedPackage: false,
      contributionConsistency: synthesis.contributionConsistency,
    },
    codeQuality,
    possibilities: synthesis.possibilities,
    uniqueContribution: synthesis.uniqueContribution,
    technicalFingerprint: synthesis.technicalFingerprint,
    searchableText,
    analyzedAt: new Date().toISOString(),
    cacheSource: "fresh",
  };

  // Persist to DB + Redis in background (don't block return)
  Promise.allSettled([
    upsertProfile({ username, name: user.name, avatar_url: user.avatar_url, bio: user.bio, location: user.location, company: user.company, blog: user.blog, followers: user.followers, public_repos: user.public_repos, github_url: user.html_url }),
    upsertAnalysis({ username, headline: synthesis.headline, domains: synthesis.domains, skills: synthesis.skills, strengths: synthesis.strengths, projects, languages: langStats, expertise_score: profile.expertiseScore, searchable_text: searchableText }),
    cacheSet(CacheKey.analysis(username), profile, TTL.ANALYSIS),
    cacheSet(nicheKey(username, query), nicheFit, TTL.SEARCH * 24),
  ]).catch((e) => console.error("[Agent3] Persist error:", e));

  console.log(`[Agent3] Done: ${username} (${Date.now() - t0}ms)`);
  return profile;
}

// ─── Niche Fit Runner ─────────────────────────────────────────────────────────

async function runNicheFit(
  profile: DeepProfileAnalysis,
  repos: GitHubRepo[],
  query: QueryAnalysis,
  username: string
): Promise<NicheFitResult | null> {
  const cached = await cacheGet<NicheFitResult>(nicheKey(username, query));
  if (cached) return cached;

  try {
    const nicheKeywords = [...query.requiredSkills, ...query.domains.flatMap((d) => d.split(" "))];
    const nicheAnalysis = await analyzeNicheCommits(username, nicheKeywords, repos);
    const fit = await evaluateNicheFit(query, nicheAnalysis, profile.codeQuality, {
      username,
      headline: profile.headline,
      domains: profile.domains,
      skills: profile.skills,
      projectDescriptions: profile.projects.map((p) => `${p.name}: ${p.description} — ${p.impact}`),
    });
    await cacheSet(nicheKey(username, query), fit, TTL.SEARCH * 24);
    return fit;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyPresence(user: GitHubUser): SocialPresence {
  return { github: user.html_url, linkedin: null, twitter: null, instagram: null, personalWebsite: null, linktree: null, blog: null, otherLinks: [], profileReadme: null, presenceScore: 1, hasWritingPresence: false };
}

function dbToProfile(db: DBAnalysis, user: GitHubUser): DeepProfileAnalysis {
  const empty: CodeQualityReport = { overallScore: 0, dimensions: [], sampledFiles: [], nicheIdiomScore: 0, isProductionGrade: false, domainPatternsFound: [], redFlags: [], greenFlags: [] };
  return {
    username: db.username, name: user.name, avatar_url: user.avatar_url, github_url: user.html_url,
    bio: user.bio, location: user.location, company: user.company,
    socialPresence: emptyPresence(user),
    headline: db.headline, domains: db.domains, skills: db.skills, strengths: db.strengths,
    projects: db.projects, languages: db.languages,
    expertiseScore: db.expertise_score, codeQualityScore: 0, isProductionGrade: false,
    nicheFit: null,
    deepGithub: { pinnedRepos: [], commitMessageQuality: "adequate", totalNicheCommits: 0, recentNicheCommits: 0, nicheRepos: [], longestContributionStreak: 0, hasPublishedPackage: false, contributionConsistency: "occasional" },
    codeQuality: empty, possibilities: [], uniqueContribution: "", technicalFingerprint: [],
    searchableText: db.searchable_text, analyzedAt: new Date().toISOString(), cacheSource: "db",
  };
}
