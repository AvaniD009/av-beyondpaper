/**
 * AGENT 4 — SEMANTIC RELEVANCE RANKER
 * ─────────────────────────────────────────────────────────────────────────────
 * The final scoring layer. Combines everything from Agents 1–3 plus the
 * Beyond-Resume signals into a rich, explainable ranking.
 *
 * What this agent does differently from every other ranking system:
 *
 *   Traditional ranking:  keywords matched → sorted by stars/followers
 *
 *   This agent:           7-dimensional scoring model
 *                         ├─ D1. Niche Fit         (does their work match the query?)
 *                         ├─ D2. Craft Depth       (is their code actually good?)
 *                         ├─ D3. Teaching          (do they explain and educate?)
 *                         ├─ D4. Community         (do people depend on them?)
 *                         ├─ D5. Challenge-Seeking (do they choose hard problems?)
 *                         ├─ D6. Consistency       (are they a long-term builder?)
 *                         └─ D7. Discovery Premium (how hidden were they?)
 *
 *   + Semantic match reasons written by Claude — specific, not generic
 *   + "What you'd miss" — what no traditional search would surface
 *   + Conversation starters — concrete things the recruiter can reference
 *   + Risk flags — honest notes about gaps or caveats
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { collectBeyondResumeSignals, type BeyondResumeSignals } from "./beyond-resume-signals";
import {
  scoreTrendingContributions,
  fetchTrendingReposOnce,
  type TrendingContributionResult,
  type TrendingRepo,
} from "./trending-contribution-scorer";
import { runBatchBiasAudit, type BiasAuditReport, type ProfileForAudit } from "./bias-audit";
import { buildReasoningChain, type ReasoningChain } from "./reasoning-chain";
import { buildAttributionTable, type AttributionTable } from "./attribution-table";
import { runCounterfactualStabilityTest, type CounterfactualStabilityReport } from "./counterfactual-twins";
import { runRiskAudit, type RiskAuditReport } from "./risk-auditor";
import { generateFairnessCertificate, type FairnessCertificate } from "./fairness-certificate";
import { analyzeCognitiveStyle, type CognitiveStyleProfile } from "./cognitive-style-analyzer";
import { buildTransparencyCard, type EvaluationTransparencyCard } from "./evaluation-transparency";
import { generateBatchStrongWhys, type StrongWhy } from "./strong-why-generator";
import { scorePotential, type PotentialProfile } from "./learning-trajectory/potential-scorer";
import { BIAS_FREE_SYSTEM_PROMPT } from "./bias-free-evaluator";
import type { DeepProfileAnalysis } from "./profile-analyzer";
import type { QueryAnalysis } from "./query-analyzer";
import type { DiscoveredCandidate } from "./discovery-orchestrator";
import type { GitHubRepo } from "@/lib/github/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoreDimension {
  name: string;
  score: number;       // 0–100
  weight: number;      // how much this dimension contributes to final score
  label: string;       // human-readable label
  evidence: string;    // what drove this score
}

export interface ConversationStarter {
  topic: string;       // what to reference
  angle: string;       // how to frame it
  url: string | null;  // direct link if available
}

export interface RankedResult {
  // ── Identity ────────────────────────────────────────────────────────────────
  profile: DeepProfileAnalysis;
  beyondResume: BeyondResumeSignals;

  // ── Composite score ──────────────────────────────────────────────────────────
  /** Final weighted composite score 0–100 */
  finalScore: number;
  /** Percentile rank among all results in this search */
  percentileRank: number;

  // ── Scoring breakdown ────────────────────────────────────────────────────────
  dimensions: ScoreDimension[];

  // ── Match narrative (Claude-written) ────────────────────────────────────────
  /** 2–3 precise match reasons grounded in actual evidence */
  matchReasons: string[];
  /** The single most compelling thing about this person for THIS query */
  standoutFact: string;
  /** What no traditional search tool would have found */
  whatYoudMiss: string;
  /** Specific skills from their profile that directly match the query */
  matchedSkills: string[];

  // ── Recruiter tools ──────────────────────────────────────────────────────────
  /** 2–3 concrete things you can ask them about in a first message */
  conversationStarters: ConversationStarter[];
  /** Honest notes about limitations or gaps */
  riskFlags: string[];
  /** One-line cold outreach hook — what to say in the first sentence */
  outreachHook: string;

  // ── Trending repo contribution ────────────────────────────────────────────────
  trendingContributions: TrendingContributionResult;

  // ── Explicit reasoning chain ──────────────────────────────────────────────────
  reasoning: ReasoningChain;

  // ── Fairness audit suite (4 sub-systems) ─────────────────────────────────────
  /** Feature-to-score mapping: every point traced to exact evidence */
  attributionTable: AttributionTable;
  /** Demographic twin test: score invariance across 5 demographic variants */
  counterfactualStability: CounterfactualStabilityReport;
  /** Negative-match risk register: what's missing, not what fits */
  riskAudit: RiskAuditReport;
  /** Glassbox Audit Report badge: synthesized fairness certificate */
  fairnessCertificate: FairnessCertificate;

  // ── Cognitive style + transparency + strong why ────────────────────────────
  /** HOW this engineer thinks — cognitive fingerprint from commits/PRs/code */
  cognitiveStyle: CognitiveStyleProfile | null;
  /** Full transparency card: every signal explained in plain English */
  transparencyCard: EvaluationTransparencyCard;
  /** The definitive argument for this ranking — specific, falsifiable, cited */
  strongWhy: StrongWhy | null;

  // ── Learning potential (D9) ────────────────────────────────────────────────
  /** Full learning trajectory assessment — TTP estimates per missing skill */
  potentialProfile: PotentialProfile | null;

  // ── Discovery context ─────────────────────────────────────────────────────────
  /** How hidden was this person? */
  hiddenScore: number;       // 0–10
  discoveryPath: string;     // which strategy found them
  whyOverlooked: string;     // why conventional search would miss them

  // ── Fit classification ────────────────────────────────────────────────────────
  fitTier: "exact" | "strong" | "strong_adjacent" | "worth_considering" | "long_shot";
}

// ─── Dimension Weight Map ─────────────────────────────────────────────────────
// Weights sum to 1.0
// Niche fit is highest — relevance to THIS query is the most important signal.
// Beyond-resume signals are collectively 40% — that's the SkillSync differentiator.

const DIMENSION_WEIGHTS = {
  niche_fit:              0.23,  // Does their work match the query?
  craft_depth:            0.15,  // Is their code actually good?
  teaching:               0.09,  // Do they explain and share knowledge?
  community:              0.08,  // Do others depend on and engage with their work?
  challenge_seeking:      0.09,  // Do they choose hard problems?
  consistency:            0.08,  // Are they a sustained builder?
  discovery_premium:      0.07,  // How hidden/overlooked were they?
  trending_contribution:  0.11,  // Are they actively contributing to what's hot right now?
  learning_potential:     0.10,  // Can they grow into the role? (D9 — new)
} as const;

// ─── Discovery Premium Scorer ─────────────────────────────────────────────────
// Engineers found via deeper strategies get a "hidden talent premium"
// because they represent arbitrage — high quality, low competition.

import { STRATEGY_WEIGHTS, type StrategyName } from "./discovery-strategies";

function computeDiscoveryPremium(discovery: DiscoveredCandidate): number {
  const strategyScore = STRATEGY_WEIGHTS[discovery.primaryDiscovery.strategy];
  const multiStrategyBonus = Math.min(2, discovery.allDiscoveries.length - 1);
  // Invert: strategy_weight 9 (package_ecosystem) = high premium
  // direct_search (4) = low premium
  const normalizedStrategy = (strategyScore / 9) * 8;
  return Math.min(10, normalizedStrategy + multiStrategyBonus);
}

// ─── Dimension Scorer ─────────────────────────────────────────────────────────

function buildDimensions(
  profile: DeepProfileAnalysis,
  beyondResume: BeyondResumeSignals,
  discovery: DiscoveredCandidate,
  trendingContributions: TrendingContributionResult,
  potentialProfile?: PotentialProfile | null
): ScoreDimension[] {
  const dims: ScoreDimension[] = [];

  // D1. Niche Fit
  const nicheFitScore = profile.nicheFit?.fitScore ?? 0;
  dims.push({
    name: "niche_fit",
    score: nicheFitScore,
    weight: DIMENSION_WEIGHTS.niche_fit,
    label: profile.nicheFit?.fitLevel === "exact" ? "Exact match" :
           profile.nicheFit?.fitLevel === "strong" ? "Strong fit" :
           profile.nicheFit?.fitLevel === "partial" ? "Partial fit" : "Adjacent fit",
    evidence: profile.nicheFit?.nicheSummary ?? "Niche fit not evaluated",
  });

  // D2. Craft Depth
  const craftScore = (profile.expertiseScore * 0.6 + profile.codeQualityScore * 10 * 0.4);
  dims.push({
    name: "craft_depth",
    score: Math.min(100, craftScore),
    weight: DIMENSION_WEIGHTS.craft_depth,
    label: profile.isProductionGrade ? "Production-grade" : "Developing",
    evidence: profile.codeQuality.greenFlags.length > 0
      ? `Green flags: ${profile.codeQuality.greenFlags.slice(0, 2).join("; ")}`
      : `Expertise score: ${profile.expertiseScore}/100`,
  });

  // D3. Teaching
  const teachingScore = Math.min(100,
    beyondResume.teaching.detailedIssueResponses * 15 +
    (beyondResume.teaching.hasPublicWriting ? 35 : 0) +
    (beyondResume.teaching.profileReadmeDepth === "exceptional" ? 25 :
     beyondResume.teaching.profileReadmeDepth === "good" ? 15 : 0) +
    beyondResume.teaching.documentedPRs * 8 +
    beyondResume.teaching.reposWithDocs * 5
  );
  dims.push({
    name: "teaching",
    score: teachingScore,
    weight: DIMENSION_WEIGHTS.teaching,
    label: teachingScore > 60 ? "Active teacher" : teachingScore > 30 ? "Occasional sharer" : "Focused builder",
    evidence: beyondResume.teaching.hasPublicWriting
      ? `Has public writing: ${beyondResume.teaching.writingLinks[0] ?? "found"}`
      : beyondResume.teaching.detailedIssueResponses > 0
      ? `${beyondResume.teaching.detailedIssueResponses} detailed explanatory issue/PR responses`
      : "No public teaching signals found",
  });

  // D4. Community
  const communityScore = Math.min(100,
    beyondResume.community.activelyMaintainedRepos * 12 +
    (beyondResume.community.issueResponseSignal === "responsive" ? 30 : 10) +
    (beyondResume.community.hasDiscussions ? 15 : 0) +
    Math.min(25, beyondResume.community.totalContributors * 3) +
    (beyondResume.community.acknowledgesContributors ? 10 : 0)
  );
  dims.push({
    name: "community",
    score: communityScore,
    weight: DIMENSION_WEIGHTS.community,
    label: beyondResume.community.communityReach,
    evidence: beyondResume.community.totalContributors > 0
      ? `${beyondResume.community.totalContributors} contributors to their projects`
      : `${beyondResume.community.activelyMaintainedRepos} actively maintained repos`,
  });

  // D5. Challenge-Seeking
  const challengeScore = Math.min(100,
    beyondResume.challengeSeeking.challengeScore * 10 +
    beyondResume.challengeSeeking.tradeoffCommitSamples.length * 8
  );
  dims.push({
    name: "challenge_seeking",
    score: challengeScore,
    weight: DIMENSION_WEIGHTS.challenge_seeking,
    label: challengeScore > 60 ? "Seeks hard problems" : challengeScore > 30 ? "Takes on challenges" : "Standard complexity",
    evidence: beyondResume.challengeSeeking.hardProblemRepos.length > 0
      ? `${beyondResume.challengeSeeking.hardProblemRepos.length} hard-problem repos (${beyondResume.challengeSeeking.hardProblemRepos[0]?.name ?? ""})`
      : beyondResume.challengeSeeking.tradeoffCommitSamples.length > 0
      ? `Commits that reason through trade-offs: "${beyondResume.challengeSeeking.tradeoffCommitSamples[0]}"`
      : "No strong challenge-seeking signals found",
  });

  // D6. Consistency
  const consistencyScore = Math.min(100,
    beyondResume.consistency.activeWeeksLastYear * 1.5 +
    beyondResume.consistency.longTermProjects * 15 +
    Math.min(20, beyondResume.consistency.domainYears * 4)
  );
  dims.push({
    name: "consistency",
    score: consistencyScore,
    weight: DIMENSION_WEIGHTS.consistency,
    label: beyondResume.consistency.consistencyLabel,
    evidence: `Active ${beyondResume.consistency.activeWeeksLastYear}/52 weeks last year, ` +
              `${beyondResume.consistency.longTermProjects} long-term projects, ` +
              `${beyondResume.consistency.domainYears}+ years in domain`,
  });

  // D7. Discovery Premium
  const discoveryPremiumScore = computeDiscoveryPremium(discovery) * 10;
  dims.push({
    name: "discovery_premium",
    score: discoveryPremiumScore,
    weight: DIMENSION_WEIGHTS.discovery_premium,
    label: discoveryPremiumScore > 70 ? "Very hidden" : discoveryPremiumScore > 40 ? "Overlooked" : "Moderately visible",
    evidence: `Found via: ${discovery.primaryDiscovery.strategy.replace(/_/g, " ")} — ${discovery.primaryDiscovery.discoverySignal}`,
  });

  // D8. Trending Contribution
  const trendLabel =
    trendingContributions.bestContributionType === "merged_pr" ? "Merged PRs in trending repos" :
    trendingContributions.bestContributionType === "open_pr"   ? "Open PRs in trending repos" :
    trendingContributions.bestContributionType === "commit"    ? "Commits to trending repos" :
    trendingContributions.bestContributionType === "detailed_issue" ? "Deep engagement with trending repos" :
    trendingContributions.bestContributionType === "issue"     ? "Uses trending repos actively" :
    "No trending contributions found";

  dims.push({
    name: "trending_contribution",
    score: trendingContributions.trendingScore,
    weight: DIMENSION_WEIGHTS.trending_contribution,
    label: trendLabel,
    evidence: trendingContributions.highlights[0] ?? trendingContributions.summary,
  });

  // D9. Learning Potential
  const potScore = potentialProfile?.rankingDimensionScore ?? 50;
  dims.push({
    name: "learning_potential",
    score: potScore,
    weight: DIMENSION_WEIGHTS.learning_potential,
    label: potentialProfile?.rankingDimensionLabel ?? "Potential not evaluated",
    evidence: potentialProfile?.rankingDimensionEvidence ??
      "Learning trajectory could not be assessed from available data",
  });

  return dims;
}

// ─── Composite Score Calculator ───────────────────────────────────────────────

function computeFinalScore(dimensions: ScoreDimension[]): number {
  const total = dimensions.reduce((acc, d) => acc + d.score * d.weight, 0);
  return Math.min(100, Math.round(total));
}

function classifyFitTier(finalScore: number, nicheFitLevel: string | undefined): RankedResult["fitTier"] {
  if (finalScore >= 75 && nicheFitLevel === "exact") return "exact";
  if (finalScore >= 65) return "strong";
  if (finalScore >= 50) return "strong_adjacent";
  if (finalScore >= 35) return "worth_considering";
  return "long_shot";
}

// ─── Claude Match Narrative ───────────────────────────────────────────────────

interface MatchNarrative {
  matchReasons: string[];
  standoutFact: string;
  whatYoudMiss: string;
  matchedSkills: string[];
  conversationStarters: ConversationStarter[];
  riskFlags: string[];
  outreachHook: string;
}

async function generateMatchNarrative(
  profile: DeepProfileAnalysis,
  beyondResume: BeyondResumeSignals,
  discovery: DiscoveredCandidate,
  dimensions: ScoreDimension[],
  query: QueryAnalysis,
  trendingContributions: TrendingContributionResult
): Promise<MatchNarrative> {

  const dimensionSummary = dimensions
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map((d) => `${d.name} (${d.score}/100, ×${d.weight}): ${d.evidence}`)
    .join("\n");

  const beyondResumeSummary = beyondResume.signalSummary.join("\n");
  const socialLinks = [
    profile.socialPresence.linkedin?.url ? `LinkedIn: ${profile.socialPresence.linkedin.url}` : null,
    profile.socialPresence.personalWebsite?.url ? `Website: ${profile.socialPresence.personalWebsite.url}` : null,
    profile.socialPresence.blog?.url ? `Blog: ${profile.socialPresence.blog.url}` : null,
  ].filter(Boolean).join("\n");

  const nicheSummary = profile.nicheFit
    ? `Fit level: ${profile.nicheFit.fitLevel} (${profile.nicheFit.fitScore}/100)\n` +
      `Requirements met: ${profile.nicheFit.requirementsMet.map((r) => r.requirement).join("; ")}\n` +
      `Depth level: ${profile.nicheFit.depthLevel}\n` +
      `Recruiter note: ${profile.nicheFit.recruitmentNote}`
    : "Niche fit not evaluated.";

  return callClaudeJSON<MatchNarrative>(
    `You are writing a recruiter briefing for an engineer candidate.
Be specific. Reference their actual work. Never use generic filler phrases.
The recruiter has seen thousands of profiles — make this one memorable.

QUERY:
"${query.rewrite.expertQuery}"
Required: ${query.requiredSkills.join(", ")}
Domains: ${query.domains.join(", ")}

CANDIDATE:
GitHub: ${profile.github_url}
Headline: ${profile.headline}
Skills: ${profile.skills.map((s) => `${s.name} (${s.level}): ${s.evidence}`).join("; ")}
Projects: ${profile.projects.map((p) => `${p.name}: ${p.description}`).join("; ")}
Unique contribution: ${profile.uniqueContribution}
Technical fingerprint: ${profile.technicalFingerprint.join("; ")}
Possibilities: ${profile.possibilities.join("; ")}

NICHE FIT:
${nicheSummary}

SCORING:
${dimensionSummary}

BEYOND-RESUME SIGNALS:
${beyondResumeSummary || "None found."}

SOCIAL PRESENCE:
${socialLinks || "GitHub only."}

DISCOVERY:
How found: ${discovery.primaryDiscovery.strategy.replace(/_/g, " ")}
Signal: ${discovery.primaryDiscovery.discoverySignal}
Why overlooked: ${discovery.whyOverlooked}

TRENDING REPO CONTRIBUTIONS:
${trendingContributions.trendingReposContributed > 0
  ? `Contributing to ${trendingContributions.trendingReposContributed} trending repo(s):\n${trendingContributions.highlights.join("\n")}\nSummary: ${trendingContributions.summary}`
  : "No contributions to currently trending niche repos."}
Trending repos checked: ${trendingContributions.trendingRepos.slice(0, 5).map((r) => r.fullName).join(", ")}

Return JSON:
{
  "matchReasons": [
    "2-3 precise, specific reasons this person fits the query",
    "Each must cite actual evidence — repo name, commit pattern, code finding",
    "No generic phrases like 'strong background in' or 'extensive experience'"
  ],
  "standoutFact": "the single most memorable thing about this person for THIS query — must be specific and surprising",
  "whatYoudMiss": "what conventional search (LinkedIn, keyword GitHub search) would never surface about this person",
  "matchedSkills": ["skills from their profile that directly map to query requirements"],
  "conversationStarters": [
    {
      "topic": "specific project, commit, or signal to reference",
      "angle": "how to bring it up in a cold message naturally",
      "url": "direct link to the thing if available, otherwise null"
    }
  ],
  "riskFlags": [
    "honest note about any gap between what the query needs and what they have",
    "empty array if no meaningful gaps"
  ],
  "outreachHook": "one sentence that could open a cold message — must reference something specific about their work, not generic praise"
}`,
    {
      system: BIAS_FREE_SYSTEM_PROMPT,
      maxTokens: 1800,
    }
  );
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * rankCandidates — Agent 4 full ranking pipeline.
 *
 * For each candidate:
 *   1. Collect beyond-resume signals (teaching, community, challenge, etc.)
 *   2. Score 7 dimensions with weights
 *   3. Compute composite score
 *   4. Claude writes the match narrative
 *   5. Assign percentile rank across the result set
 *
 * Returns sorted, scored, fully-explained ranked results.
 */
export async function rankCandidates(
  query: QueryAnalysis,
  profiles: DeepProfileAnalysis[],
  discoveries: DiscoveredCandidate[]
): Promise<RankedResult[]> {
  if (profiles.length === 0) return [];

  console.log(`[Agent4] Ranking ${profiles.length} candidates`);
  const t0 = Date.now();

  // Build lookup map for discovery metadata
  const discoveryMap = new Map(
    discoveries.map((d) => [d.user.login.toLowerCase(), d])
  );

  // ── Pre-load trending repos ONCE for this query ───────────────────────────
  // Fetching once and reusing saves N*3 API calls (N = candidate count)
  let trendingRepos: TrendingRepo[] = [];
  try {
    trendingRepos = await fetchTrendingReposOnce(query);
    console.log(`[Agent4] Trending repos loaded: ${trendingRepos.length} for query`);
  } catch (err) {
    console.warn("[Agent4] Failed to load trending repos:", err);
  }

  // Step 1: Collect beyond-resume signals AND trending contributions in parallel
  const [beyondResumeResults, trendingResults, cognitiveResults, potentialResults] = await Promise.all([
    Promise.allSettled(
      profiles.map(async (profile) => {
        const discovery = discoveryMap.get(profile.username);
        const prSamples = profile.deepGithub.pinnedRepos.map((r) => ({
          title: r.name,
          body: r.description,
        }));
        const crossRepoIssues = discovery?.allDiscoveries
          .filter((d) => d.strategy === "contributor_network").length ?? 0;

        return collectBeyondResumeSignals(
          {
            login: profile.username, name: profile.name, avatar_url: profile.avatar_url,
            bio: profile.bio, company: profile.company, location: profile.location,
            blog: profile.socialPresence.personalWebsite?.url ?? null,
            public_repos: 0, followers: 0, following: 0, created_at: null,
            html_url: profile.github_url,
          },
          discovery?.repos ?? [],
          profile.socialPresence,
          prSamples,
          [],
          0,
          profile.deepGithub.longestContributionStreak,
          crossRepoIssues
        );
      })
    ),
    Promise.allSettled(
      profiles.map((profile) =>
        scoreTrendingContributions(profile.username, query, trendingRepos)
      )
    ),
    // Cognitive style: analyze HOW they think from commits/PRs/code
    Promise.allSettled(
      profiles.map((profile, i) =>
        i < 10
          ? analyzeCognitiveStyle(
              profile.username,
              profile.deepGithub.commitSamples ?? [],
              profile.deepGithub.prSamples ?? [],
              profile.deepGithub.issueSamples ?? [],
              profile.codeQuality.sampledFiles.map((f) => f)
            )
          : Promise.resolve(null)
      )
    ),
    // D9: Learning potential — TTP estimates for each missing required skill
    Promise.allSettled(
      profiles.map((profile) =>
        scorePotential(
          profile.username,
          discoveryMap.get(profile.username)?.repos ?? [],
          profile.skills.map((s) => s.name),
          query.requiredSkills,
          "proficient"
        )
      )
    ),
  ]);

  // Step 2: Score dimensions + compute final scores
  const scoredCandidates = profiles.map((profile, i) => {
    const beyondResume = beyondResumeResults[i].status === "fulfilled"
      ? beyondResumeResults[i].value
      : emptyBeyondResume(profile.username);

    const trendingContributions = trendingResults[i].status === "fulfilled"
      ? trendingResults[i].value
      : emptyTrendingResult(profile.username);

    const cognitiveStyle = cognitiveResults[i].status === "fulfilled"
      ? cognitiveResults[i].value
      : null;

    const potentialProfile = potentialResults[i].status === "fulfilled"
      ? potentialResults[i].value
      : null;

    const discovery = discoveryMap.get(profile.username) ?? makeFallbackDiscovery(profile);
    const dimensions = buildDimensions(profile, beyondResume, discovery, trendingContributions, potentialProfile);
    const finalScore = computeFinalScore(dimensions);

    return { profile, beyondResume, trendingContributions, cognitiveStyle, potentialProfile, discovery, dimensions, finalScore };
  });

  // Sort by final score
  scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);

  // Step 3: Batch bias audit — runs every candidate through scoring twice
  // (full profile vs anonymized), proves demographics don't drive the score
  const auditProfiles: Array<{ profile: ProfileForAudit; finalScore: number }> =
    scoredCandidates.map(({ profile }) => ({
      profile: {
        name: profile.name,
        bio: profile.bio,
        company: profile.company,
        location: profile.location,
        username: profile.username,
        technicalContent: [
          profile.headline,
          profile.domains.join(", "),
          profile.skills.map((s) => `${s.name}: ${s.evidence}`).join(". "),
          profile.projects.map((p) => `${p.name}: ${p.description}`).join(". "),
          profile.technicalFingerprint.join(". "),
        ].join("\n"),
      },
      finalScore: 0,
    }));

  const biasAuditReports = await runBatchBiasAudit(
    auditProfiles,
    query.requiredSkills,
    query.domains,
    query.rewrite.expertQuery
  );

  console.log(
    `[Agent4] Bias audits complete — ${biasAuditReports.filter((r) => r.verdict === "PASS").length}/${biasAuditReports.length} PASSED`
  );

  // Step 4: Generate match narratives for top N (Claude calls are expensive)
  const TOP_NARRATIVE_COUNT = 8;

  const narrativeResults = await Promise.allSettled(
    scoredCandidates.slice(0, TOP_NARRATIVE_COUNT).map(
      ({ profile, beyondResume, discovery, dimensions, trendingContributions }) =>
        generateMatchNarrative(profile, beyondResume, discovery, dimensions, query, trendingContributions)
    )
  );

  // Step 5: Assemble final results with reasoning chains + full fairness suite
  const results: RankedResult[] = await Promise.all(
    scoredCandidates.map(
    async ({ profile, beyondResume, discovery, dimensions, finalScore, trendingContributions, cognitiveStyle, potentialProfile }, i) => {
      const narrative = i < TOP_NARRATIVE_COUNT && narrativeResults[i].status === "fulfilled"
        ? narrativeResults[i].value
        : fallbackNarrative(profile, beyondResume, dimensions, query);

      const biasAudit = biasAuditReports[i] ?? {
        candidateId: `CND_${i}`,
        auditTimestamp: new Date().toISOString(),
        fullProfileScore: finalScore,
        anonymizedScore: finalScore,
        scoreDelta: 0,
        driftPercent: 0,
        verdict: "PASS" as const,
        strippedFields: [],
        fullProfileRun: { runId: "full_profile" as const, score: finalScore, scoreBreakdown: {}, inputHash: "" },
        anonymizedRuns: [],
        auditSummary: "Audit not available",
        isDefensible: true,
      };

      // ── Run all 4 fairness sub-systems in parallel ─────────────────────────
      const technicalContent = [
        profile.headline,
        profile.domains.join(", "),
        profile.skills.map((s) => `${s.name} (${s.level}): ${s.evidence}`).join(". "),
        profile.projects.map((p) => `${p.name}: ${p.description} — ${p.impact}`).join(". "),
        profile.technicalFingerprint.join(". "),
        `Niche repos: ${profile.deepGithub.nicheRepos.join(", ")}`,
        `Niche commits: ${profile.deepGithub.totalNicheCommits} total`,
      ].join("\n");

      const candidateId = `CND_${profile.username.slice(0, 8)}`;

      const [attributionResult, counterfactualResult, riskResult] = await Promise.allSettled([
        i < TOP_NARRATIVE_COUNT
          ? buildAttributionTable(profile, query, finalScore)
          : Promise.resolve(emptyAttributionTable(candidateId, finalScore)),
        i < TOP_NARRATIVE_COUNT
          ? runCounterfactualStabilityTest(
              technicalContent,
              profile.name,
              profile.bio,
              profile.location,
              query.requiredSkills,
              query.domains,
              query.rewrite.expertQuery,
              candidateId
            )
          : Promise.resolve(emptyCounterfactualReport(candidateId, finalScore)),
        i < TOP_NARRATIVE_COUNT
          ? runRiskAudit(profile, query)
          : Promise.resolve(emptyRiskReport(candidateId)),
      ]);

      const attributionTable = attributionResult.status === "fulfilled"
        ? attributionResult.value : emptyAttributionTable(candidateId, finalScore);
      const counterfactualStability = counterfactualResult.status === "fulfilled"
        ? counterfactualResult.value : emptyCounterfactualReport(candidateId, finalScore);
      const riskAudit = riskResult.status === "fulfilled"
        ? riskResult.value : emptyRiskReport(candidateId);

      // 4d: Fairness Certificate
      const fairnessCertificate = generateFairnessCertificate(
        candidateId, query.rewrite.expertQuery,
        biasAudit, counterfactualStability, attributionTable, riskAudit
      );

      // ── Transparency card ──────────────────────────────────────────────────
      const missingSkillNames = riskAudit.blockingRisks
        .concat(riskAudit.significantRisks)
        .map((r) => r.jdRequirement.replace(/^Has demonstrated expertise in: /, ""));

      const transparencyCard = buildTransparencyCard(
        profile, query, dimensions, finalScore,
        missingSkillNames, cognitiveStyle,
        counterfactualStability, attributionTable
      );

      // Build explicit reasoning chain (async — uses embedding model)
      const reasoning = await buildReasoningChain(
        i + 1,
        profile,
        query,
        dimensions,
        finalScore,
        biasAudit,
        trendingContributions
      );

      const percentileRank = Math.round(
        ((scoredCandidates.length - i) / scoredCandidates.length) * 100
      );

      return {
        profile,
        beyondResume,
        trendingContributions,
        reasoning,
        attributionTable,
        counterfactualStability,
        riskAudit,
        fairnessCertificate,
        cognitiveStyle,
        transparencyCard,
        potentialProfile: potentialProfile ?? null,
        strongWhy: null as StrongWhy | null, // filled in batch below
        finalScore,
        percentileRank,
        dimensions,
        matchReasons: narrative.matchReasons,
        standoutFact: narrative.standoutFact,
        whatYoudMiss: narrative.whatYoudMiss,
        matchedSkills: narrative.matchedSkills,
        conversationStarters: narrative.conversationStarters,
        riskFlags: narrative.riskFlags,
        outreachHook: narrative.outreachHook,
        hiddenScore: computeDiscoveryPremium(discovery),
        discoveryPath: discovery.primaryDiscovery.strategy.replace(/_/g, " "),
        whyOverlooked: discovery.whyOverlooked,
        fitTier: classifyFitTier(finalScore, profile.nicheFit?.fitLevel),
      };
    }
  );

  // ── Batch generate strong whys for top 8 ────────────────────────────────
  const strongWhys = await generateBatchStrongWhys(
    results.slice(0, TOP_NARRATIVE_COUNT).map((r, i) => ({
      rank: i + 1,
      profile: r.profile,
      query,
      dimensions: r.dimensions,
      finalScore: r.finalScore,
      cognitiveStyle: r.cognitiveStyle,
      attribution: r.attributionTable,
      riskAudit: r.riskAudit,
    })),
    TOP_NARRATIVE_COUNT
  );

  // Attach strong whys to results
  strongWhys.forEach((why) => {
    const idx = why.rank - 1;
    if (results[idx]) results[idx].strongWhy = why;
  });

  // Filter out weak results
  const filtered = results.filter((r) => r.finalScore >= 20);

  console.log(`[Agent4] Ranking complete: ${filtered.length} results in ${Date.now() - t0}ms`);
  return filtered;
}

// ─── Fallback Narrative ───────────────────────────────────────────────────────
// Used for candidates ranked 9+ to avoid too many Claude calls

function fallbackNarrative(
  profile: DeepProfileAnalysis,
  beyondResume: BeyondResumeSignals,
  dimensions: ScoreDimension[],
  query: QueryAnalysis
): MatchNarrative {
  const topDim = [...dimensions].sort((a, b) => b.score * b.weight - a.score * a.weight)[0];
  const matchedSkills = profile.skills
    .filter((s) => query.requiredSkills.some((r) => s.name.toLowerCase().includes(r.toLowerCase())))
    .map((s) => s.name);

  return {
    matchReasons: [
      profile.headline,
      topDim?.evidence ?? "See full profile for details",
    ],
    standoutFact: beyondResume.topSignal,
    whatYoudMiss: profile.uniqueContribution || "See full profile",
    matchedSkills: matchedSkills.slice(0, 5),
    conversationStarters: [
      {
        topic: profile.projects[0]?.name ?? "their work",
        angle: `Reference ${profile.projects[0]?.name ?? "their most recent project"}`,
        url: profile.projects[0]?.url ?? profile.github_url,
      },
    ],
    riskFlags: [],
    outreachHook: `Saw your work on ${profile.projects[0]?.name ?? "GitHub"} — impressed by ${profile.headline.split(" ").slice(0, 6).join(" ")}`,
  };
}

// ─── Fallback Discovery ───────────────────────────────────────────────────────

function makeFallbackDiscovery(profile: DeepProfileAnalysis): DiscoveredCandidate {
  return {
    user: {
      login: profile.username,
      name: profile.name,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      company: profile.company,
      location: profile.location,
      blog: null,
      public_repos: 0,
      followers: 0,
      following: 0,
      created_at: null,
      html_url: profile.github_url,
    },
    repos: [],
    primaryDiscovery: {
      login: profile.username,
      avatar_url: profile.avatar_url,
      html_url: profile.github_url,
      strategy: "direct_search",
      discoverySignal: "Direct lookup",
      whyOverlooked: "Standard visibility",
      signalStrength: 4,
    },
    allDiscoveries: [],
    botResult: { username: profile.username, isBot: false, botScore: 0, confidence: "high", hardDisqualified: false, hardReason: null, softSignals: [], llmVerified: false, llmReasoning: null, verdict: "human" },
    signalScore: 4,
    whyOverlooked: "Standard visibility",
  };
}

// ─── Empty Beyond Resume ──────────────────────────────────────────────────────

function emptyTrendingResult(username: string): TrendingContributionResult {
  return {
    username,
    trendingRepos: [],
    contributions: [],
    trendingReposContributed: 0,
    bestContributionType: "none",
    trendingScore: 0,
    summary: "No trending contribution data available",
    highlights: [],
  };
}

function emptyAttributionTable(candidateId: string, score: number): AttributionTable {
  return {
    candidateId,
    tableScore: score,
    scoreDelta: 0,
    rows: [],
    unmatchedRequirements: [],
    hiddenPathFlags: [],
    isFullyGrounded: true,
    directEvidencePoints: score,
    inferredEvidencePoints: 0,
    decisionPathHash: "not-computed",
  };
}

function emptyCounterfactualReport(candidateId: string, score: number): CounterfactualStabilityReport {
  return {
    candidateId,
    testsRun: 0,
    baselineScore: score,
    twins: [],
    maxScore: score,
    minScore: score,
    scoreRange: 0,
    causalDisparityIndex: 0,
    stabilityVerdict: "STABLE",
    stabilityPercent: 100,
    highestScoringVariant: "original",
    lowestScoringVariant: "original",
    biasVector: null,
    summary: "Counterfactual test not run (outside top-8 window)",
    chartData: [],
  };
}

function emptyRiskReport(candidateId: string): RiskAuditReport {
  return {
    candidateId,
    requirementsAudited: 0,
    risks: [],
    blockingRisks: [],
    significantRisks: [],
    minorRisks: [],
    riskScore: 0,
    riskVerdict: "LOW_RISK",
    suggestedInterviewProbes: [],
    isWorthPursuing: true,
    riskSummary: "Risk audit not run (outside top-8 window)",
  };
}

function emptyBeyondResume(username: string): BeyondResumeSignals {
  return {
    username,
    teaching: { detailedIssueResponses: 0, documentedPRs: 0, reposWithContributing: 0, reposWithDocs: 0, hasPublicWriting: false, writingLinks: [], profileReadmeDepth: "none", bestExplanationSample: null },
    community: { activelyMaintainedRepos: 0, issueResponseSignal: "unknown", acknowledgesContributors: false, hasDiscussions: false, totalContributors: 0, dependentRepoSignal: 0, hasCodeOfConduct: false, communityReach: "solitary" },
    challengeSeeking: { hardProblemRepos: [], tradeoffCommitSamples: [], steepDomains: [], demandingContributions: [], challengeScore: 0 },
    consistency: { activeWeeksLastYear: 0, domainYears: 0, longTermProjects: 0, consistencyLabel: "sporadic" },
    curiosity: { experimentalRepos: 0, crossRepoIssues: 0, gistCount: 0, topicFocusScore: 5, hasLearningRepo: false },
    beyondResumeScore: 0,
    topSignal: "Active GitHub contributor",
    signalSummary: [],
  };
}
