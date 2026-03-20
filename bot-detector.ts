/**
 * AGENT 2b — BOT DETECTOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-signal scoring system to filter bot and non-human accounts from
 * discovery results before they waste any downstream API calls or AI tokens.
 *
 * Design principles:
 * - Hard disqualifiers run first: O(1) cost, no API calls needed
 * - Soft signals accumulate into a botScore (0.0 = definitely human, 1.0 = bot)
 * - LLM verification ONLY for borderline zone (0.35–0.55), never for clear cases
 * - All reasoning is logged so humans can audit the decision
 * - Errs on the side of INCLUSION: a false negative (passing a bot) is caught
 *   by Agent 3's depth analysis. A false positive (blocking a real engineer)
 *   is unrecoverable. Threshold is deliberately lenient.
 */

import { callClaudeJSON } from "@/lib/claude/client";
import type { GitHubUser, GitHubRepo } from "@/lib/github/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotDetectionResult {
  username: string;
  isBot: boolean;
  botScore: number;           // 0.0 (human) → 1.0 (bot)
  confidence: "certain" | "high" | "medium" | "low";
  hardDisqualified: boolean;  // triggered a hard rule
  hardReason: string | null;  // which hard rule fired
  softSignals: SoftSignal[];  // all soft signals evaluated
  llmVerified: boolean;       // did LLM confirm/deny?
  llmReasoning: string | null;
  verdict: "human" | "bot" | "borderline_passed" | "borderline_rejected";
}

interface SoftSignal {
  signal: string;
  value: unknown;
  score: number;    // contribution to botScore: positive = more bot-like
  weight: number;   // how much this signal matters
  note: string;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const HARD_REJECT_THRESHOLD = 1.0;   // hard disqualifiers set score = 1.0
const SOFT_BOT_THRESHOLD = 0.65;     // above this: reject without LLM
const SOFT_HUMAN_THRESHOLD = 0.30;   // below this: accept without LLM
const LLM_ZONE_LOW = 0.30;
const LLM_ZONE_HIGH = 0.65;

// ─── Known bot username patterns ─────────────────────────────────────────────

const BOT_USERNAME_PATTERNS = [
  /\[bot\]$/i,
  /-bot$/i,
  /^bot-/i,
  /^github-actions/i,
  /^dependabot/i,
  /^renovate/i,
  /^snyk-bot/i,
  /^imgbot/i,
  /^allcontributors/i,
  /^stale\[bot\]/i,
  /^codecov/i,
  /^semantic-release-bot/i,
  /^pull\[bot\]/i,
  /^probot/i,
  /^merge-queue-bot/i,
  /^greenkeeper/i,
];

// ─── Username Entropy ─────────────────────────────────────────────────────────
// High entropy = random character string = likely bot-generated name.
// Real people choose meaningful usernames.

function usernameEntropy(username: string): number {
  const freq: Record<string, number> = {};
  for (const ch of username.toLowerCase().replace(/[-_]/g, "")) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  const len = username.length;
  if (len === 0) return 0;

  return -Object.values(freq).reduce((acc, count) => {
    const p = count / len;
    return acc + p * Math.log2(p);
  }, 0);
}

// ─── Commit Timing Variance ───────────────────────────────────────────────────
// Bots commit at machine-regular intervals. Humans are irregular.
// We approximate this from createdAt dates of repos (not actual commit times,
// to avoid extra API calls).

function repoCreationVariance(repos: GitHubRepo[]): number {
  if (repos.length < 3) return 1.0; // not enough data, assume human
  const dates = repos
    .filter((r) => r.created_at)
    .map((r) => new Date(r.created_at!).getTime())
    .sort((a, b) => a - b);

  if (dates.length < 2) return 1.0;
  const intervals = [];
  for (let i = 1; i < dates.length; i++) {
    intervals.push(dates[i] - dates[i - 1]);
  }

  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance =
    intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
  const stdDev = Math.sqrt(variance);

  // Coefficient of variation: low = suspiciously regular
  const cv = mean > 0 ? stdDev / mean : 0;
  return cv; // >0.5 = normal human, <0.1 = suspicious bot regularity
}

// ─── Commit Message Uniformity ────────────────────────────────────────────────
// Sample repo names as a proxy (actual commit messages need extra API calls).
// All-lowercase, minimal-word repo names suggest auto-generated content.

function repoNameUniformity(repos: GitHubRepo[]): number {
  if (repos.length === 0) return 0.5;
  const names = repos.map((r) => r.name.toLowerCase());
  // Pattern: "repo1", "repo2", "project-1", "test-2024" etc.
  const genericPattern = /^(repo|project|test|app|website|hello|sample|demo|fork|clone)[\d-]*/;
  const genericCount = names.filter((n) => genericPattern.test(n)).length;
  return genericCount / names.length;
}

// ─── Profile Completeness ─────────────────────────────────────────────────────

function profileCompleteness(user: GitHubUser): number {
  let score = 0;
  let max = 0;

  const check = (has: boolean, weight: number) => {
    max += weight;
    if (has) score += weight;
  };

  check(!!user.name && user.name.length > 1, 3);           // has a real name
  check(!!user.bio && user.bio.length > 10, 3);             // has a bio
  check(!!user.location, 1);                                // location set
  check(!!user.company, 1);                                 // company set
  check(!!user.blog && user.blog.length > 3, 2);            // has a website
  check(user.followers > 0, 1);                             // at least 1 follower
  check(user.following > 0, 1);                             // follows someone
  check(user.public_repos > 2, 2);                          // has repos

  return max > 0 ? score / max : 0; // 0.0 = empty profile, 1.0 = full
}

// ─── Original Repo Ratio ──────────────────────────────────────────────────────

function originalRepoRatio(repos: GitHubRepo[]): number {
  if (repos.length === 0) return 0;
  const originals = repos.filter((r) => !r.is_fork).length;
  return originals / repos.length;
}

// ─── README Quality Proxy ─────────────────────────────────────────────────────

function readmeQualitySignal(repos: GitHubRepo[]): number {
  const withReadme = repos.filter(
    (r) => r.readme_excerpt && r.readme_excerpt.length > 150
  ).length;
  return repos.length > 0 ? withReadme / Math.min(repos.length, 4) : 0;
}

// ─── HARD DISQUALIFIERS ───────────────────────────────────────────────────────

function checkHardDisqualifiers(
  user: GitHubUser,
  repos: GitHubRepo[]
): { disqualified: boolean; reason: string | null } {
  // 1. Username matches known bot patterns
  for (const pattern of BOT_USERNAME_PATTERNS) {
    if (pattern.test(user.login)) {
      return { disqualified: true, reason: `Username matches bot pattern: ${pattern}` };
    }
  }

  // 2. Account has no original repos at all
  const originals = repos.filter((r) => !r.is_fork);
  if (repos.length > 5 && originals.length === 0) {
    return { disqualified: true, reason: "All repos are forks — no original work" };
  }

  // 3. Ghost profile: nothing set, never active
  if (
    !user.bio &&
    !user.name &&
    !user.blog &&
    user.followers === 0 &&
    user.public_repos < 2
  ) {
    return { disqualified: true, reason: "Ghost profile: no identity signals at all" };
  }

  // 4. Extreme follower asymmetry typical of follow-bots
  if (user.following > 5000 && user.followers < 10) {
    return {
      disqualified: true,
      reason: `Follow-bot pattern: following ${user.following} but only ${user.followers} followers`,
    };
  }

  // 5. Username is pure random alphanumeric (entropy > 4.2 bits/char)
  const entropy = usernameEntropy(user.login);
  if (entropy > 4.2 && user.login.length > 10 && !user.bio && !user.name) {
    return {
      disqualified: true,
      reason: `Username has suspicious entropy (${entropy.toFixed(2)} bits/char) with empty profile`,
    };
  }

  return { disqualified: false, reason: null };
}

// ─── SOFT SIGNAL COLLECTION ───────────────────────────────────────────────────

function collectSoftSignals(
  user: GitHubUser,
  repos: GitHubRepo[]
): SoftSignal[] {
  const signals: SoftSignal[] = [];

  // 1. Profile completeness (higher = more human)
  const completeness = profileCompleteness(user);
  signals.push({
    signal: "profile_completeness",
    value: completeness,
    score: completeness < 0.3 ? 0.4 : completeness > 0.6 ? -0.1 : 0.1,
    weight: 2.5,
    note: `Profile ${Math.round(completeness * 100)}% complete`,
  });

  // 2. Original repo ratio
  const origRatio = originalRepoRatio(repos);
  signals.push({
    signal: "original_repo_ratio",
    value: origRatio,
    score: origRatio < 0.2 ? 0.5 : origRatio > 0.6 ? -0.2 : 0.1,
    weight: 2.0,
    note: `${Math.round(origRatio * 100)}% of repos are original (not forks)`,
  });

  // 3. Username entropy
  const entropy = usernameEntropy(user.login);
  signals.push({
    signal: "username_entropy",
    value: entropy,
    score: entropy > 3.8 ? 0.3 : entropy < 2.5 ? -0.1 : 0.05,
    weight: 1.5,
    note: `Username entropy: ${entropy.toFixed(2)} bits/char`,
  });

  // 4. Has external link
  const hasLink = !!(user.blog && user.blog.length > 5);
  signals.push({
    signal: "has_external_link",
    value: hasLink,
    score: hasLink ? -0.2 : 0.15,
    weight: 1.5,
    note: hasLink ? "Has blog/website link" : "No external link",
  });

  // 5. Repo creation variance (low variance = suspicious regularity)
  const cv = repoCreationVariance(repos);
  signals.push({
    signal: "repo_timing_variance",
    value: cv,
    score: cv < 0.15 && repos.length > 4 ? 0.35 : cv > 0.5 ? -0.1 : 0.05,
    weight: 1.0,
    note: `Repo creation timing CV: ${cv.toFixed(2)}`,
  });

  // 6. Repo name uniformity (generic naming = more bot-like)
  const nameUniformity = repoNameUniformity(repos);
  signals.push({
    signal: "repo_name_uniformity",
    value: nameUniformity,
    score: nameUniformity > 0.6 ? 0.3 : nameUniformity < 0.2 ? -0.1 : 0.05,
    weight: 1.5,
    note: `${Math.round(nameUniformity * 100)}% of repos have generic names`,
  });

  // 7. README presence signal
  const readmeSignal = readmeQualitySignal(repos);
  signals.push({
    signal: "readme_quality",
    value: readmeSignal,
    score: readmeSignal < 0.2 && repos.length > 3 ? 0.2 : readmeSignal > 0.5 ? -0.15 : 0,
    weight: 1.5,
    note: `README quality signal: ${readmeSignal.toFixed(2)}`,
  });

  // 8. Bio quality
  const bioLen = user.bio?.length ?? 0;
  signals.push({
    signal: "bio_quality",
    value: bioLen,
    score: bioLen === 0 ? 0.2 : bioLen > 30 ? -0.15 : 0,
    weight: 2.0,
    note: bioLen === 0 ? "No bio" : `Bio length: ${bioLen} chars`,
  });

  // 9. Account age signal (very new accounts with lots of repos = suspicious)
  if (user.created_at) {
    const ageMs = Date.now() - new Date(user.created_at).getTime();
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
    const repoPerMonth = ageMonths > 0 ? user.public_repos / ageMonths : 0;
    signals.push({
      signal: "activity_density",
      value: repoPerMonth,
      score: repoPerMonth > 15 && ageMonths < 2 ? 0.4 : repoPerMonth < 5 ? 0 : 0.05,
      weight: 1.5,
      note: `${repoPerMonth.toFixed(1)} repos/month over ${ageMonths.toFixed(0)} months`,
    });
  }

  // 10. Language diversity — bots tend to be monolingual
  const langs = new Set(repos.map((r) => r.language).filter(Boolean));
  signals.push({
    signal: "language_diversity",
    value: langs.size,
    score: langs.size === 0 && repos.length > 3 ? 0.2 : langs.size > 2 ? -0.05 : 0.05,
    weight: 0.5,
    note: `${langs.size} distinct languages used`,
  });

  return signals;
}

// ─── SCORE AGGREGATOR ─────────────────────────────────────────────────────────

function aggregateScore(signals: SoftSignal[]): number {
  const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
  if (totalWeight === 0) return 0.5;

  const weightedScore = signals.reduce((a, s) => a + s.score * s.weight, 0);
  // Normalize to 0–1 range, centered at 0.5
  const raw = 0.5 + weightedScore / totalWeight;
  return Math.max(0, Math.min(1, raw));
}

// ─── LLM BORDERLINE VERIFICATION ─────────────────────────────────────────────

async function llmVerifyBorderline(
  user: GitHubUser,
  repos: GitHubRepo[],
  softSignals: SoftSignal[],
  botScore: number
): Promise<{ isBot: boolean; reasoning: string }> {
  const repoNames = repos.slice(0, 8).map((r) => r.name).join(", ");
  const signalSummary = softSignals
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
    .map((s) => `${s.signal}: ${s.note}`)
    .join("; ");

  return callClaudeJSON<{ isBot: boolean; reasoning: string }>(
    `You are classifying a GitHub account as human or bot. Your ONLY job is classification.

ACCOUNT DATA:
Username: ${user.login}
Name: ${user.name ?? "none"}
Bio: ${user.bio ?? "none"}
Followers: ${user.followers} | Following: ${user.following}
Public repos: ${user.public_repos}
Has website: ${!!user.blog}
Repo names: ${repoNames || "none"}

SIGNALS:
${signalSummary}

Preliminary bot score: ${botScore.toFixed(2)} (0=human, 1=bot) — this is BORDERLINE, hence manual review.

Is this account a bot or automation account? Consider:
- Does the profile look like a real person or automation?
- Do the repo names suggest real projects or generated content?
- Does anything indicate this is a GitHub Action, Renovate, Dependabot, or similar?

Return JSON: { "isBot": true/false, "reasoning": "one sentence" }`,
    { maxTokens: 128 }
  );
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * detectBot — full multi-signal bot detection pipeline.
 *
 * Stages:
 *   1. Hard disqualifiers (instant reject, no scoring)
 *   2. Soft signal collection + weighted score
 *   3. Clear cases: accept/reject without LLM
 *   4. Borderline zone (0.30–0.65): LLM verification
 *
 * @param repos - Pass already-fetched repos to avoid extra API calls.
 *               Pass [] if not available; detection still works with less confidence.
 */
export async function detectBot(
  user: GitHubUser,
  repos: GitHubRepo[] = []
): Promise<BotDetectionResult> {
  const { disqualified, reason } = checkHardDisqualifiers(user, repos);

  if (disqualified) {
    return {
      username: user.login,
      isBot: true,
      botScore: 1.0,
      confidence: "certain",
      hardDisqualified: true,
      hardReason: reason,
      softSignals: [],
      llmVerified: false,
      llmReasoning: null,
      verdict: "bot",
    };
  }

  const softSignals = collectSoftSignals(user, repos);
  const botScore = aggregateScore(softSignals);

  // Clear human
  if (botScore < SOFT_HUMAN_THRESHOLD) {
    return {
      username: user.login,
      isBot: false,
      botScore,
      confidence: "high",
      hardDisqualified: false,
      hardReason: null,
      softSignals,
      llmVerified: false,
      llmReasoning: null,
      verdict: "human",
    };
  }

  // Clear bot
  if (botScore > SOFT_BOT_THRESHOLD) {
    return {
      username: user.login,
      isBot: true,
      botScore,
      confidence: "high",
      hardDisqualified: false,
      hardReason: null,
      softSignals,
      llmVerified: false,
      llmReasoning: null,
      verdict: "bot",
    };
  }

  // Borderline zone: use LLM for final call
  let llmResult: { isBot: boolean; reasoning: string };
  try {
    llmResult = await llmVerifyBorderline(user, repos, softSignals, botScore);
  } catch {
    // If LLM fails, default to passing (err on side of inclusion)
    llmResult = { isBot: false, reasoning: "LLM verification failed — defaulting to pass" };
  }

  return {
    username: user.login,
    isBot: llmResult.isBot,
    botScore,
    confidence: "medium",
    hardDisqualified: false,
    hardReason: null,
    softSignals,
    llmVerified: true,
    llmReasoning: llmResult.reasoning,
    verdict: llmResult.isBot ? "borderline_rejected" : "borderline_passed",
  };
}

/**
 * filterBots — batch filter a list of users, runs detections concurrently.
 * Returns only accounts that passed (isBot = false).
 */
export async function filterBots(
  users: Array<{ user: GitHubUser; repos?: GitHubRepo[] }>
): Promise<Array<{ user: GitHubUser; botResult: BotDetectionResult }>> {
  const results = await Promise.allSettled(
    users.map(async ({ user, repos }) => {
      const botResult = await detectBot(user, repos ?? []);
      return { user, botResult };
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<{ user: GitHubUser; botResult: BotDetectionResult }> =>
      r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter(({ botResult }) => !botResult.isBot);
}
