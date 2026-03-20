/**
 * BEYOND-RESUME SIGNAL COLLECTOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Collects all the signals that a resume, LinkedIn profile, or even a GitHub
 * profile page cannot capture on its own.
 *
 * Signal categories:
 *
 *   1. TEACHING SIGNALS
 *      → Do they take time to explain things to others?
 *      → Do they write documentation that teaches, not just describes?
 *      → Do they respond to issues with explanations, not just fixes?
 *      → Do they review PRs with thoughtful feedback?
 *
 *   2. COMMUNITY SIGNALS
 *      → Do they maintain projects that others depend on?
 *      → Do they respond to their users?
 *      → Do they acknowledge contributors?
 *      → Do they have a CONTRIBUTING.md, CODE_OF_CONDUCT, discussions?
 *
 *   3. CHALLENGE-SEEKING SIGNALS
 *      → Do they voluntarily take on hard problems?
 *      → Do their commit messages reference difficult trade-offs?
 *      → Do they file detailed bug reports on hard-to-reproduce issues?
 *      → Do they build tools in domains with steep learning curves?
 *
 *   4. CONSISTENCY SIGNALS
 *      → GitHub contribution streak
 *      → Domain focus over time (not scattered)
 *      → Long-term project maintenance (not just build-and-abandon)
 *
 *   5. CURIOSITY SIGNALS
 *      → Do they file issues on libraries they use with genuine questions?
 *      → Do they comment on other engineers' repos with insight?
 *      → Do they have gists that explore ideas?
 *      → Do they have experimental repos?
 *
 *   6. EXTERNAL RECOGNITION SIGNALS (weak but real)
 *      → Are they cited in other repos' READMEs?
 *      → Have they been thanked in changelogs?
 *      → Do others open issues referencing their work?
 */

import { octokit } from "@/lib/github/client";
import type { GitHubUser, GitHubRepo } from "@/lib/github/client";
import type { SocialPresence } from "@/lib/github/social-discoverer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeachingSignals {
  /** Issues where they gave a detailed explanation (not just "fixed") */
  detailedIssueResponses: number;
  /** PRs where they wrote a thorough description with context and reasoning */
  documentedPRs: number;
  /** Repos with a CONTRIBUTING.md (invites others in) */
  reposWithContributing: number;
  /** Repos with Wiki or detailed docs/ directory */
  reposWithDocs: number;
  /** Presence of blog posts, talks, tutorials they've written */
  hasPublicWriting: boolean;
  writingLinks: string[];
  /** Profile README quality — do they explain their work to strangers? */
  profileReadmeDepth: "none" | "minimal" | "good" | "exceptional";
  /** Sample of their most explanatory issue/PR comment */
  bestExplanationSample: string | null;
}

export interface CommunitySignals {
  /** Repos with open issues they've responded to */
  activelyMaintainedRepos: number;
  /** Average response time to issues (approximated from samples) */
  issueResponseSignal: "responsive" | "moderate" | "inactive" | "unknown";
  /** Repos with CONTRIBUTORS acknowledgment */
  acknowledgesContributors: boolean;
  /** Has GitHub Discussions enabled */
  hasDiscussions: boolean;
  /** Total contributors across their repos */
  totalContributors: number;
  /** Repos depending on their work (via dependency graph proxy) */
  dependentRepoSignal: number;
  /** Has code of conduct */
  hasCodeOfConduct: boolean;
  /** Stars as a community-interest proxy (NOT quality proxy) */
  communityReach: "solitary" | "small" | "growing" | "established";
}

export interface ChallengeSeekerSignals {
  /** Repos that tackle inherently hard problems (inferred from topics + description) */
  hardProblemRepos: Array<{ name: string; why: string }>;
  /** Commit messages that reference difficult trade-offs */
  tradeoffCommitSamples: string[];
  /** Evidence they worked in steep-learning-curve domains */
  steepDomains: string[];
  /** Have they contributed to projects known to be technically demanding? */
  demandingContributions: string[];
  /** Challenge score 0–10 */
  challengeScore: number;
}

export interface ConsistencySignals {
  /** GitHub contribution streak (weeks active in last year) */
  activeWeeksLastYear: number;
  /** Years they've been active in their PRIMARY domain (not just on GitHub) */
  domainYears: number;
  /** Number of repos maintained for 2+ years */
  longTermProjects: number;
  /** Consistency label */
  consistencyLabel: "daily_builder" | "consistent" | "project_based" | "sporadic";
}

export interface CuriositySignals {
  /** Experimental / research / explore named repos */
  experimentalRepos: number;
  /** Issues filed on OTHER people's projects (shows active usage and curiosity) */
  crossRepoIssues: number;
  /** Gist count (quick explorations) */
  gistCount: number;
  /** Topics breadth vs depth (too many = scattered, focused = deep) */
  topicFocusScore: number;
  /** Has a "til" (today I learned) or "notes" or "journal" repo */
  hasLearningRepo: boolean;
}

export interface BeyondResumeSignals {
  username: string;
  teaching: TeachingSignals;
  community: CommunitySignals;
  challengeSeeking: ChallengeSeekerSignals;
  consistency: ConsistencySignals;
  curiosity: CuriositySignals;
  /** Composite beyond-resume score 0–100 */
  beyondResumeScore: number;
  /** The single most impressive beyond-resume signal */
  topSignal: string;
  /** All significant signals as human-readable bullets */
  signalSummary: string[];
}

// ─── Hard Problem Domain Map ──────────────────────────────────────────────────
// Domains that signal willingness to tackle difficult problems

const HARD_PROBLEM_INDICATORS = {
  topics: new Set([
    "formal-verification", "theorem-proving", "type-theory", "dependent-types",
    "compiler", "interpreter", "garbage-collection", "memory-allocator",
    "distributed-consensus", "raft", "paxos", "crdt",
    "zero-knowledge-proof", "zkp", "homomorphic-encryption",
    "operating-system", "kernel", "hypervisor",
    "real-time", "rtos", "embedded",
    "query-optimizer", "database-internals", "storage-engine",
    "program-synthesis", "static-analysis", "abstract-interpretation",
    "neural-architecture-search", "reinforcement-learning",
    "computational-geometry", "numerical-methods",
  ]),
  descriptionKeywords: [
    "without", "from scratch", "pure", "no dependencies", "zero-copy",
    "lock-free", "wait-free", "formally verified", "provably", "theorem",
    "from first principles", "novel", "research", "paper implementation",
  ],
};

function detectHardProblemRepo(repo: GitHubRepo): string | null {
  const text = [
    repo.description ?? "",
    (repo.topics ?? []).join(" "),
    repo.name,
  ].join(" ").toLowerCase();

  // Check topics
  for (const topic of repo.topics ?? []) {
    if (HARD_PROBLEM_INDICATORS.topics.has(topic)) {
      return `tagged "${topic}" — inherently challenging domain`;
    }
  }

  // Check description keywords
  for (const kw of HARD_PROBLEM_INDICATORS.descriptionKeywords) {
    if (text.includes(kw)) {
      return `description signals "built ${kw}" — willingness to do it the hard way`;
    }
  }

  return null;
}

// ─── Teaching Signal Detector ─────────────────────────────────────────────────

function scoreProfileReadme(readme: string | null): TeachingSignals["profileReadmeDepth"] {
  if (!readme) return "none";
  const len = readme.length;
  const hasHeaders = /^#+\s/m.test(readme);
  const hasBadges = /!\[.*?\]\(.*?\)/.test(readme);
  const hasCodeBlocks = /```/.test(readme);
  const hasTechList = /##.*(?:skills?|tech|stack|tools?)/i.test(readme);
  const hasProjectDesc = /##.*(?:project|work|build)/i.test(readme);
  const score =
    (len > 2000 ? 3 : len > 500 ? 2 : len > 100 ? 1 : 0) +
    (hasHeaders ? 1 : 0) +
    (hasCodeBlocks ? 1 : 0) +
    (hasTechList ? 1 : 0) +
    (hasProjectDesc ? 1 : 0);
  return score >= 6 ? "exceptional" : score >= 4 ? "good" : "minimal";
}

// ─── Community Signal Collector ───────────────────────────────────────────────

async function collectCommunitySignals(
  username: string,
  repos: GitHubRepo[]
): Promise<CommunitySignals> {
  const originals = repos.filter((r) => !r.is_fork);

  const activelyMaintained = originals.filter((r) => {
    const lastUpdate = r.updated_at ? Date.now() - new Date(r.updated_at).getTime() : Infinity;
    return lastUpdate < 1000 * 60 * 60 * 24 * 180; // updated in last 6mo
  }).length;

  const hasCodeOfConduct = originals.some((r) =>
    (r.topics ?? []).includes("code-of-conduct")
  );

  const acknowledgesContributors = originals.some((r) =>
    (r.topics ?? []).some((t) => ["all-contributors", "hacktoberfest", "good-first-issue"].includes(t))
  );

  // Approximate total contributors via top repo
  let totalContributors = 0;
  let hasDiscussions = false;
  let dependentSignal = 0;

  const topRepo = originals.sort((a, b) => b.stargazers_count - a.stargazers_count)[0];
  if (topRepo) {
    const [owner, repoName] = topRepo.full_name.split("/");
    try {
      const { data: contributors } = await octokit.repos.listContributors({
        owner,
        repo: repoName,
        per_page: 30,
        anon: "false",
      });
      totalContributors = contributors.filter((c) => c.login !== username).length;
    } catch { /* skip */ }

    try {
      const { data: repoData } = await octokit.repos.get({ owner, repo: repoName });
      hasDiscussions = !!(repoData as Record<string, unknown>).has_discussions;
      dependentSignal = (repoData.network_count ?? 0) + (repoData.subscribers_count ?? 0);
    } catch { /* skip */ }
  }

  const totalStars = originals.reduce((a, r) => a + r.stargazers_count, 0);
  const communityReach: CommunitySignals["communityReach"] =
    totalStars > 1000 ? "established" :
    totalStars > 100 ? "growing" :
    totalStars > 10 ? "small" : "solitary";

  // Issue response signal: check if they respond to their own repo issues
  let issueResponseSignal: CommunitySignals["issueResponseSignal"] = "unknown";
  if (originals.some((r) => r.open_issues_count > 0)) {
    try {
      const { data: issues } = await octokit.issues.listForRepo({
        owner: username,
        repo: originals[0].name,
        state: "all",
        per_page: 10,
      });
      const withComments = issues.filter((i) => i.comments > 0).length;
      issueResponseSignal =
        withComments / issues.length > 0.6 ? "responsive" :
        withComments / issues.length > 0.3 ? "moderate" : "inactive";
    } catch { /* skip */ }
  }

  return {
    activelyMaintainedRepos: activelyMaintained,
    issueResponseSignal,
    acknowledgesContributors,
    hasDiscussions,
    totalContributors,
    dependentRepoSignal: dependentSignal,
    hasCodeOfConduct,
    communityReach,
  };
}

// ─── Challenge Seeker Signals ─────────────────────────────────────────────────

async function collectChallengeSeekerSignals(
  username: string,
  repos: GitHubRepo[]
): Promise<ChallengeSeekerSignals> {
  const hardRepos: Array<{ name: string; why: string }> = [];
  const steepDomains = new Set<string>();

  for (const repo of repos.filter((r) => !r.is_fork)) {
    const why = detectHardProblemRepo(repo);
    if (why) {
      hardRepos.push({ name: repo.name, why });
      // Extract domain
      for (const t of repo.topics ?? []) {
        if (HARD_PROBLEM_INDICATORS.topics.has(t)) steepDomains.add(t);
      }
    }
  }

  // Scan commit messages for trade-off language
  const tradeoffPatterns = [
    /\bvs\b|\bversus\b/i,
    /trade.?off/i,
    /\bpros\b.*\bcons\b|\bcons\b.*\bpros\b/i,
    /chose.*because|decided.*instead/i,
    /\bperf\b.*\bcorrect|\bcorrect.*\bperf/i,
    /memory.*speed|speed.*memory/i,
    /rollback|revert.*reason|undo.*because/i,
    /naive.*approach|better.*algorithm/i,
    /\bO\([n²nlogn]+\)/i,
  ];

  const tradeoffSamples: string[] = [];

  // Fetch commits for top 3 repos to find trade-off messages
  await Promise.allSettled(
    repos.filter((r) => !r.is_fork).slice(0, 3).map(async (repo) => {
      try {
        const [owner, repoName] = repo.full_name.split("/");
        const { data: commits } = await octokit.repos.listCommits({
          owner, repo: repoName, author: username, per_page: 30,
        });
        for (const c of commits) {
          const msg = c.commit.message;
          if (tradeoffPatterns.some((p) => p.test(msg))) {
            tradeoffSamples.push(msg.split("\n")[0].trim().slice(0, 100));
          }
        }
      } catch { /* skip */ }
    })
  );

  // Demanding external contributions (repos that aren't theirs but they contributed to)
  const demandingContributions: string[] = [];
  try {
    const { data: events } = await octokit.activity.listPublicEventsForUser({
      username,
      per_page: 30,
    });
    for (const event of events) {
      if (event.type === "PushEvent" || event.type === "PullRequestEvent") {
        const repoName = event.repo?.name ?? "";
        if (!repoName.startsWith(`${username}/`) && repoName) {
          demandingContributions.push(repoName);
        }
      }
    }
  } catch { /* skip */ }

  const challengeScore = Math.min(10,
    hardRepos.length * 2 +
    tradeoffSamples.length * 0.5 +
    steepDomains.size * 1.5 +
    Math.min(demandingContributions.length, 3)
  );

  return {
    hardProblemRepos: hardRepos.slice(0, 5),
    tradeoffCommitSamples: [...new Set(tradeoffSamples)].slice(0, 5),
    steepDomains: [...steepDomains],
    demandingContributions: [...new Set(demandingContributions)].slice(0, 5),
    challengeScore,
  };
}

// ─── Consistency Signals ──────────────────────────────────────────────────────

function collectConsistencySignals(
  repos: GitHubRepo[],
  activeWeeksLastYear: number
): ConsistencySignals {
  const originals = repos.filter((r) => !r.is_fork);

  // Long-term projects: original repos older than 2 years still being updated
  const twoYearsAgo = Date.now() - 1000 * 60 * 60 * 24 * 365 * 2;
  const longTermProjects = originals.filter((r) => {
    const created = r.created_at ? new Date(r.created_at).getTime() : Infinity;
    const updated = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    return created < twoYearsAgo && updated > Date.now() - 1000 * 60 * 60 * 24 * 365;
  }).length;

  // Domain years: oldest repo in primary language
  const sortedByAge = [...originals]
    .filter((r) => r.created_at)
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

  const domainYears = sortedByAge.length > 0
    ? Math.floor((Date.now() - new Date(sortedByAge[0].created_at!).getTime()) / (1000 * 60 * 60 * 24 * 365))
    : 0;

  const consistencyLabel: ConsistencySignals["consistencyLabel"] =
    activeWeeksLastYear > 40 ? "daily_builder" :
    activeWeeksLastYear > 25 ? "consistent" :
    activeWeeksLastYear > 12 ? "project_based" : "sporadic";

  return { activeWeeksLastYear, domainYears, longTermProjects, consistencyLabel };
}

// ─── Curiosity Signals ────────────────────────────────────────────────────────

function collectCuriositySignals(
  repos: GitHubRepo[],
  gistCount: number,
  crossRepoIssues: number
): CuriositySignals {
  const originals = repos.filter((r) => !r.is_fork);

  const experimentalPatterns = [
    /^experiment/i, /^explore/i, /^research/i, /^poc$/i, /^prototype/i,
    /^try-/i, /^testing-/i, /^playground/i, /-lab$/i, /-sandbox$/i,
    /^til$/i, /^notes$/i, /^journal$/i, /^learning/i, /^study/i,
  ];

  const experimentalRepos = originals.filter((r) =>
    experimentalPatterns.some((p) => p.test(r.name))
  ).length;

  const hasLearningRepo = originals.some((r) =>
    [/^til$/i, /^notes$/i, /^journal$/i, /^learning/i, /today-i-learned/i].some((p) => p.test(r.name))
  );

  // Topic focus score: too many unrelated topics = scattered
  const allTopics = originals.flatMap((r) => r.topics ?? []);
  const uniqueTopics = new Set(allTopics).size;
  const topicFocusScore = originals.length > 0
    ? Math.max(0, 10 - Math.max(0, uniqueTopics - originals.length * 2))
    : 5;

  return {
    experimentalRepos,
    crossRepoIssues,
    gistCount,
    topicFocusScore: Math.min(10, topicFocusScore),
    hasLearningRepo,
  };
}

// ─── Teaching Signals ─────────────────────────────────────────────────────────

async function collectTeachingSignals(
  username: string,
  repos: GitHubRepo[],
  social: SocialPresence,
  prSamples: Array<{ title: string; body: string | null }>,
  issueSamples: Array<{ title: string; body: string | null }>
): Promise<TeachingSignals> {
  const originals = repos.filter((r) => !r.is_fork);

  const reposWithContributing = originals.filter((r) =>
    (r.topics ?? []).includes("contributing") ||
    r.description?.toLowerCase().includes("contributing")
  ).length;

  const reposWithDocs = originals.filter((r) =>
    (r.topics ?? []).some((t) => ["docs", "documentation", "wiki", "tutorial"].includes(t))
  ).length;

  // Score PRs by body length and quality
  const documentedPRs = prSamples.filter(
    (pr) => pr.body && pr.body.length > 150
  ).length;

  // Score issues by explanation depth
  const detailedIssues = issueSamples.filter(
    (i) => i.body && i.body.length > 200 &&
    (i.body.includes("because") || i.body.includes("since") || i.body.includes("steps to"))
  ).length;

  // Find best explanation sample
  const bestExplanation = [...issueSamples, ...prSamples]
    .filter((s) => s.body && s.body.length > 200)
    .sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0))[0]?.body?.slice(0, 300) ?? null;

  const writingLinks = [
    social.blog?.url,
    ...social.otherLinks.filter((l) => ["medium", "substack", "devto", "hashnode"].includes(l.platform)).map((l) => l.url),
  ].filter(Boolean) as string[];

  return {
    detailedIssueResponses: detailedIssues,
    documentedPRs,
    reposWithContributing,
    reposWithDocs,
    hasPublicWriting: writingLinks.length > 0 || social.hasWritingPresence,
    writingLinks,
    profileReadmeDepth: scoreProfileReadme(social.profileReadme),
    bestExplanationSample: bestExplanation,
  };
}

// ─── Composite Score ──────────────────────────────────────────────────────────

function computeBeyondResumeScore(
  teaching: TeachingSignals,
  community: CommunitySignals,
  challenge: ChallengeSeekerSignals,
  consistency: ConsistencySignals,
  curiosity: CuriositySignals
): number {
  let score = 0;

  // Teaching (25 pts max)
  score += Math.min(8, teaching.detailedIssueResponses * 2);
  score += Math.min(4, teaching.documentedPRs * 1.5);
  score += teaching.hasPublicWriting ? 6 : 0;
  score += teaching.profileReadmeDepth === "exceptional" ? 4 :
           teaching.profileReadmeDepth === "good" ? 2 : 0;
  score += Math.min(3, teaching.reposWithDocs);

  // Community (20 pts max)
  score += Math.min(6, community.activelyMaintainedRepos * 2);
  score += community.issueResponseSignal === "responsive" ? 5 :
           community.issueResponseSignal === "moderate" ? 2 : 0;
  score += community.hasDiscussions ? 3 : 0;
  score += Math.min(4, community.totalContributors * 0.5);
  score += community.acknowledgesContributors ? 2 : 0;

  // Challenge seeking (20 pts max)
  score += Math.min(12, challenge.challengeScore * 1.2);
  score += Math.min(5, challenge.tradeoffCommitSamples.length * 1.5);
  score += Math.min(3, challenge.demandingContributions.length);

  // Consistency (20 pts max)
  score += Math.min(10, consistency.activeWeeksLastYear * 0.2);
  score += Math.min(6, consistency.longTermProjects * 2);
  score += Math.min(4, consistency.domainYears);

  // Curiosity (15 pts max)
  score += Math.min(5, curiosity.experimentalRepos * 2);
  score += Math.min(4, curiosity.crossRepoIssues * 0.5);
  score += Math.min(3, curiosity.gistCount * 0.3);
  score += curiosity.hasLearningRepo ? 2 : 0;
  score += Math.min(1, curiosity.topicFocusScore * 0.1);

  return Math.min(100, Math.round(score));
}

// ─── Top Signal Finder ────────────────────────────────────────────────────────

function findTopSignal(
  teaching: TeachingSignals,
  community: CommunitySignals,
  challenge: ChallengeSeekerSignals,
  consistency: ConsistencySignals,
  curiosity: CuriositySignals
): string {
  const signals: Array<[number, string]> = [
    [teaching.detailedIssueResponses * 15, `Writes detailed, explanatory issue responses (${teaching.detailedIssueResponses} found) — they take time to teach, not just fix`],
    [teaching.hasPublicWriting ? 60 : 0, `Publishes technical writing publicly — actively shares knowledge with the broader community`],
    [teaching.profileReadmeDepth === "exceptional" ? 55 : 0, "Has an exceptional GitHub profile README — puts real effort into communicating who they are and what they know"],
    [community.issueResponseSignal === "responsive" ? 50 : 0, "Responsive to their users — actively maintains and engages with people depending on their work"],
    [challenge.challengeScore * 8, `${challenge.hardProblemRepos.length} hard-problem repos — voluntarily chooses the steep path`],
    [challenge.tradeoffCommitSamples.length * 12, `${challenge.tradeoffCommitSamples.length} commit messages that reason through trade-offs — they think, not just code`],
    [community.totalContributors * 3, `${community.totalContributors} contributors across their projects — their work attracts collaborators`],
    [consistency.longTermProjects * 20, `${consistency.longTermProjects} projects maintained for 2+ years — not a build-and-abandon engineer`],
    [consistency.activeWeeksLastYear * 0.8, `Active ${consistency.activeWeeksLastYear}/52 weeks last year — consistent, sustained builder`],
    [curiosity.hasLearningRepo ? 40 : 0, "Has a public learning/TIL repo — openly documents what they're learning"],
    [community.hasDiscussions ? 30 : 0, "Uses GitHub Discussions — builds conversation, not just code"],
  ];

  return signals.sort((a, b) => b[0] - a[0])[0]?.[1] ?? "Active GitHub contributor";
}

// ─── Signal Summary Builder ───────────────────────────────────────────────────

function buildSignalSummary(
  teaching: TeachingSignals,
  community: CommunitySignals,
  challenge: ChallengeSeekerSignals,
  consistency: ConsistencySignals,
  curiosity: CuriositySignals
): string[] {
  const bullets: string[] = [];

  if (teaching.hasPublicWriting)
    bullets.push(`📝 Publishes technical content (${teaching.writingLinks[0] ?? "blog/articles"})`);
  if (teaching.detailedIssueResponses > 2)
    bullets.push(`💬 Writes explanatory issue responses — takes time to teach, not just close tickets`);
  if (teaching.profileReadmeDepth === "exceptional" || teaching.profileReadmeDepth === "good")
    bullets.push(`✨ Maintains a ${teaching.profileReadmeDepth} profile README — cares about communicating their work`);
  if (teaching.documentedPRs > 1)
    bullets.push(`📋 ${teaching.documentedPRs} well-documented PRs — explains their reasoning, not just their changes`);

  if (community.issueResponseSignal === "responsive")
    bullets.push(`🤝 Responsive maintainer — actively engages with users and contributors`);
  if (community.totalContributors > 3)
    bullets.push(`👥 ${community.totalContributors} contributors to their projects — attracts collaborators`);
  if (community.communityReach === "growing" || community.communityReach === "established")
    bullets.push(`🌱 ${community.communityReach} community reach — others find and use their work`);
  if (community.hasDiscussions)
    bullets.push(`💭 Uses GitHub Discussions — creates space for community conversation`);

  if (challenge.hardProblemRepos.length > 0)
    bullets.push(`🧗 ${challenge.hardProblemRepos.length} hard-problem repos — deliberately chooses challenging projects (${challenge.hardProblemRepos[0]?.name})`);
  if (challenge.tradeoffCommitSamples.length > 0)
    bullets.push(`⚖️ Commit messages that reason through trade-offs — thinks about why, not just what`);
  if (challenge.demandingContributions.length > 0)
    bullets.push(`🔧 Contributes to demanding external projects (${challenge.demandingContributions[0]})`);

  if (consistency.longTermProjects > 0)
    bullets.push(`⏱️ ${consistency.longTermProjects} project(s) maintained for 2+ years — not a build-and-abandon pattern`);
  if (consistency.consistencyLabel === "daily_builder")
    bullets.push(`🔥 Daily builder — active ${consistency.activeWeeksLastYear}/52 weeks last year`);
  else if (consistency.consistencyLabel === "consistent")
    bullets.push(`📅 Consistent contributor — active most weeks of the year`);
  if (consistency.domainYears > 3)
    bullets.push(`📆 ${consistency.domainYears}+ years in their domain — long-term expertise, not a recent pivot`);

  if (curiosity.hasLearningRepo)
    bullets.push(`🧠 Public learning repo — openly documents what they're exploring`);
  if (curiosity.experimentalRepos > 2)
    bullets.push(`🔬 ${curiosity.experimentalRepos} experimental repos — actively tries new ideas`);

  return bullets;
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

export async function collectBeyondResumeSignals(
  user: GitHubUser,
  repos: GitHubRepo[],
  social: SocialPresence,
  prSamples: Array<{ title: string; body: string | null }>,
  issueSamples: Array<{ title: string; body: string | null }>,
  gistCount: number,
  activeWeeksLastYear: number,
  crossRepoIssues: number
): Promise<BeyondResumeSignals> {

  const [teaching, community, challenge] = await Promise.all([
    collectTeachingSignals(user.login, repos, social, prSamples, issueSamples),
    collectCommunitySignals(user.login, repos),
    collectChallengeSeekerSignals(user.login, repos),
  ]);

  const consistency = collectConsistencySignals(repos, activeWeeksLastYear);
  const curiosity = collectCuriositySignals(repos, gistCount, crossRepoIssues);

  const beyondResumeScore = computeBeyondResumeScore(teaching, community, challenge, consistency, curiosity);
  const topSignal = findTopSignal(teaching, community, challenge, consistency, curiosity);
  const signalSummary = buildSignalSummary(teaching, community, challenge, consistency, curiosity);

  return {
    username: user.login,
    teaching,
    community,
    challengeSeeking: challenge,
    consistency,
    curiosity,
    beyondResumeScore,
    topSignal,
    signalSummary,
  };
}
