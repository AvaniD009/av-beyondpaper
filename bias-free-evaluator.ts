/**
 * BIAS FIREWALL — Non-Bias Profile Evaluator
 * ─────────────────────────────────────────────────────────────────────────────
 * Sits between raw GitHub data and Claude's analysis.
 * 
 * Core principle (SkillSync's own ethos):
 * "We don't want to classify developers as good/bad. We find POSSIBILITIES."
 * 
 * The firewall enforces this by stripping all social-proof and demographic
 * signals before Claude ever sees the profile. Claude evaluates CRAFT and
 * DEPTH — never fame, affiliation, or visibility.
 *
 * What gets stripped (social proof / demographic):
 *   ✗ Star counts          → fame bias
 *   ✗ Fork counts          → viral bias
 *   ✗ Follower/following   → network bias
 *   ✗ Company affiliation  → brand bias (ex-Google ≠ better)
 *   ✗ Location             → geographic bias
 *   ✗ Account age          → experience-assumption bias
 *   ✗ Contributor rank     → hierarchy bias
 *   ✗ Email domain         → institutional bias
 *
 * What gets preserved (craft / depth signals):
 *   ✓ What they built (repo descriptions, READMEs)
 *   ✓ How they built it (language choices, architecture)
 *   ✓ How they think (commit message samples)
 *   ✓ How they reason (issue/PR excerpts)
 *   ✓ How they classify their work (topic self-tags)
 *   ✓ How deep they go (dependency choices, test coverage signals)
 *   ✓ Domain focus vs breadth
 */

import type { GitHubUser, GitHubRepo } from "@/lib/github/client";

// ─── Anonymized Profile ───────────────────────────────────────────────────────
// This is what Claude sees. Everything else is stripped.

export interface AnonymizedProfile {
  /** Opaque internal ID — not the real username. Claude must not infer from this. */
  profileId: string;

  /** Repos stripped of all social signals */
  repos: AnonymizedRepo[];

  /** Aggregated language distribution (percentages, not absolute numbers) */
  languageDistribution: Record<string, number>;

  /** Domain self-tags the engineer assigned to their repos */
  selfAssignedTopics: string[];

  /** Number of domains covered — breadth signal without naming them */
  domainBreadth: "focused" | "moderate" | "broad";

  /** How long they've been active in THIS domain (not overall account age) */
  domainTenure: "< 1 year" | "1–2 years" | "2–4 years" | "4+ years";

  /** Craft signals derived from structure — not vanity metrics */
  craftSignals: CraftSignal[];

  /** Commit message samples (anonymized: usernames/emails stripped) */
  commitSampleCount: number; // We don't have these without extra API calls, so count only

  /** Whether they've published to a package registry — strong expertise signal */
  hasPublishedPackage: boolean;

  /** Discovery path — tells Claude HOW they were found, not WHO they are */
  discoveryContext: string;
}

export interface AnonymizedRepo {
  /** Internal name — can be real repo name, it's not PII */
  name: string;
  /** Description text — preserved */
  description: string | null;
  /** README excerpt — the most important signal */
  readmeExcerpt: string | null;
  /** Primary language */
  language: string | null;
  /** Topic tags (self-assigned) */
  topics: string[];
  /** Repo size bucket — not exact KB (removes size-as-proxy-for-effort bias) */
  sizeBucket: "tiny" | "small" | "medium" | "large" | "huge";
  /** Whether it has open issues (signals community engagement) */
  hasOpenIssues: boolean;
  /** Days since last meaningful update */
  lastUpdatedDaysAgo: number;
  /** Whether it's actively maintained */
  isActive: boolean;
  /** Presence of key craft signals in repo structure */
  hasCIConfig: boolean;
  hasTests: boolean;
  hasContributing: boolean;
  hasChangelog: boolean;
  /** STRIPPED: stars, forks, watchers, owner info, clone_url, created_at (raw) */
}

export interface CraftSignal {
  signal: string;
  present: boolean;
  note: string;
}

// ─── Bias Firewall Transform ──────────────────────────────────────────────────

export function applyBiasFirewall(
  user: GitHubUser,
  repos: GitHubRepo[],
  discoveryContext: string,
  hasPublishedPackage: boolean = false
): AnonymizedProfile {
  // Generate opaque profile ID — NOT username, NOT based on any PII
  const profileId = `profile_${hashString(user.login)}`;

  // Anonymize repos
  const anonymizedRepos: AnonymizedRepo[] = repos
    .filter((r) => !r.is_fork)  // Forks don't demonstrate authorship
    .slice(0, 8)
    .map((r) => anonymizeRepo(r));

  // Language distribution (percentages only)
  const languageDistribution = computeLanguageDistribution(repos);

  // Collect all self-assigned topics
  const allTopics = [...new Set(repos.flatMap((r) => r.topics ?? []))].slice(0, 15);

  // Domain breadth: how many distinct domains do their repos span?
  const domainBreadth = computeDomainBreadth(repos);

  // Domain tenure: how long have they been working in THIS domain
  // (approximated from oldest relevant repo — not account age)
  const domainTenure = computeDomainTenure(repos);

  // Craft signals: structural quality indicators
  const craftSignals = computeCraftSignals(repos, user);

  return {
    profileId,
    repos: anonymizedRepos,
    languageDistribution,
    selfAssignedTopics: allTopics,
    domainBreadth,
    domainTenure,
    craftSignals,
    commitSampleCount: 0, // Would need extra API calls; reserved for future
    hasPublishedPackage,
    discoveryContext,
  };
}

// ─── Repo Anonymizer ─────────────────────────────────────────────────────────

function anonymizeRepo(repo: GitHubRepo): AnonymizedRepo {
  const sizeKB = repo.size ?? 0;
  const sizeBucket: AnonymizedRepo["sizeBucket"] =
    sizeKB < 10 ? "tiny" :
    sizeKB < 100 ? "small" :
    sizeKB < 1000 ? "medium" :
    sizeKB < 10000 ? "large" : "huge";

  const lastUpdated = repo.updated_at
    ? Math.floor((Date.now() - new Date(repo.updated_at).getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  // Clean README excerpt: strip any usernames, GitHub links, email addresses
  const cleanReadme = repo.readme_excerpt
    ? sanitizeReadmeExcerpt(repo.readme_excerpt)
    : null;

  return {
    name: repo.name,
    description: repo.description,
    readmeExcerpt: cleanReadme,
    language: repo.language,
    topics: repo.topics ?? [],
    sizeBucket,
    hasOpenIssues: (repo.open_issues_count ?? 0) > 0,
    lastUpdatedDaysAgo: lastUpdated,
    isActive: lastUpdated < 180, // Updated in last 6 months
    // Craft signals derived from topics/description heuristics
    // (full detection would need repo contents API — approximate here)
    hasCIConfig: (repo.topics ?? []).some((t) =>
      ["ci", "github-actions", "travis-ci", "circleci"].includes(t)
    ),
    hasTests: (repo.description ?? "").toLowerCase().includes("test") ||
              (repo.topics ?? []).includes("testing"),
    hasContributing: (repo.topics ?? []).includes("contributing") ||
                     (repo.description ?? "").toLowerCase().includes("contributing"),
    hasChangelog: (repo.topics ?? []).includes("changelog"),
    // STRIPPED: stars, forks, watchers, owner, created_at (exact), clone_url
  };
}

// ─── Helper: Language Distribution ───────────────────────────────────────────

function computeLanguageDistribution(repos: GitHubRepo[]): Record<string, number> {
  const total = repos.reduce((a, r) => a + (r.size ?? 0), 0);
  if (total === 0) return {};

  const raw: Record<string, number> = {};
  for (const repo of repos.filter((r) => !r.is_fork && r.language)) {
    raw[repo.language!] = (raw[repo.language!] ?? 0) + (repo.size ?? 0);
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([lang, size]) => [lang, Math.round((size / total) * 100)])
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 6)
  );
}

// ─── Helper: Domain Breadth ───────────────────────────────────────────────────

function computeDomainBreadth(repos: GitHubRepo[]): AnonymizedProfile["domainBreadth"] {
  const languages = new Set(repos.filter((r) => !r.is_fork && r.language).map((r) => r.language));
  const topicCount = new Set(repos.flatMap((r) => r.topics ?? [])).size;
  const signal = languages.size + topicCount * 0.3;
  return signal < 4 ? "focused" : signal < 10 ? "moderate" : "broad";
}

// ─── Helper: Domain Tenure ────────────────────────────────────────────────────

function computeDomainTenure(repos: GitHubRepo[]): AnonymizedProfile["domainTenure"] {
  const dates = repos
    .filter((r) => !r.is_fork && r.created_at)
    .map((r) => new Date(r.created_at!).getTime())
    .sort((a, b) => a - b);

  if (dates.length === 0) return "< 1 year";
  const oldestMs = dates[0];
  const yearsAgo = (Date.now() - oldestMs) / (1000 * 60 * 60 * 24 * 365);

  return yearsAgo < 1 ? "< 1 year" :
         yearsAgo < 2 ? "1–2 years" :
         yearsAgo < 4 ? "2–4 years" : "4+ years";
}

// ─── Helper: Craft Signals ────────────────────────────────────────────────────

function computeCraftSignals(repos: GitHubRepo[], user: GitHubUser): CraftSignal[] {
  const originals = repos.filter((r) => !r.is_fork);
  const withReadme = originals.filter((r) => r.readme_excerpt && r.readme_excerpt.length > 200);
  const withDescription = originals.filter((r) => r.description && r.description.length > 20);

  return [
    {
      signal: "documentation_investment",
      present: withReadme.length / Math.max(originals.length, 1) > 0.4,
      note: `${withReadme.length}/${originals.length} original repos have substantive READMEs`,
    },
    {
      signal: "project_clarity",
      present: withDescription.length / Math.max(originals.length, 1) > 0.5,
      note: `${withDescription.length}/${originals.length} repos have clear descriptions`,
    },
    {
      signal: "domain_focus",
      present: computeDomainBreadth(repos) === "focused",
      note: "Engineer is focused on a specific domain rather than scattered",
    },
    {
      signal: "sustained_activity",
      present: originals.some((r) => {
        const days = r.updated_at
          ? (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24)
          : 999;
        return days < 90;
      }),
      note: "Has active repos updated in the last 90 days",
    },
    {
      signal: "portfolio_depth",
      present: originals.length >= 3,
      note: `${originals.length} original repos — sufficient portfolio to evaluate`,
    },
    {
      signal: "external_communication",
      present: !!(user.blog || user.bio),
      note: user.blog
        ? "Maintains external presence (blog/website)"
        : user.bio
        ? "Written bio showing communication willingness"
        : "No external communication signals",
    },
  ];
}

// ─── Helper: README Sanitizer ─────────────────────────────────────────────────
// Strips personal identifiers from README excerpts before Claude sees them

function sanitizeReadmeExcerpt(text: string): string {
  return text
    // Strip GitHub URLs that contain usernames
    .replace(/https?:\/\/github\.com\/[\w-]+/gi, "https://github.com/[author]")
    // Strip badge URLs with usernames
    .replace(/https?:\/\/img\.shields\.io\/github\/[^\s)]+/gi, "[badge]")
    // Strip email addresses
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, "[email]")
    // Strip Twitter/X handles
    .replace(/@[\w]{2,30}/g, "@[handle]")
    // Cap length
    .slice(0, 1000);
}

// ─── Helper: String Hash (for opaque IDs) ────────────────────────────────────

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Bias-Free System Prompt ──────────────────────────────────────────────────
// The Claude system prompt that enforces bias-free evaluation.
// Used by Agent 3 (ProfileAnalyzer).

export const BIAS_FREE_SYSTEM_PROMPT = `You are a talent discovery engine specialized in finding engineering possibilities.

Your evaluation philosophy (from SkillSync):
"We don't want to classify developers as good or bad. We find POSSIBILITIES in each contributor.
 We look at how people contribute differently — their unique technical fingerprint."

CRITICAL BIAS RULES — violating these invalidates the entire analysis:

1. NO FAME BIAS: You have not been given star counts or follower counts.
   Do not try to infer them. A project with 0 stars solving a hard problem
   beats a project with 10,000 stars that is a tutorial wrapper.

2. NO AFFILIATION BIAS: Do not give credit for company names, university names,
   or organizational associations. Code quality lives in code, not in logos.

3. NO DEMOGRAPHIC INFERENCE: Do not infer location, nationality, gender, or age
   from usernames, profile IDs, or writing style. Evaluate work, not identity.

4. NO RECENCY BIAS: Older, sustained work is often a stronger signal than
   recent bursts of activity. Someone working in a niche for 4 years matters.

5. NO SIZE BIAS: A solo engineer maintaining a focused 500-line library
   demonstrates more expertise than a contributor with 10,000 commits spread
   across unrelated beginner projects.

6. POSSIBILITIES OVER GRADES: Your output must describe what this person CAN DO
   and where their expertise CREATES POSSIBILITIES — not whether they're "good enough."
   There is no "not good enough." There is only "not the right fit for this query."

What you ARE evaluating:
- The DEPTH of their understanding (do they solve root causes or symptoms?)
- The CRAFT of their work (do they care about how they build, not just what?)
- The DOMAIN SPECIFICITY (do they know this space better than generalists?)
- The UNIQUENESS of their contribution (what do they bring that others don't?)
- The EVIDENCE quality (are their claims backed by actual code and docs?)`;
