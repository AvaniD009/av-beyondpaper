/**
 * EVALUATION TRANSPARENCY LAYER
 * ─────────────────────────────────────────────────────────────────────────────
 * Gives the user complete visibility into what is being evaluated, why each
 * signal was chosen, how confident the system is in each assessment, and
 * where the data came from.
 *
 * This is the answer to "what is being evaluated?" at every stage.
 *
 * Design principle: every signal the system uses to make a decision must
 * have a corresponding transparency entry that explains:
 *   - WHAT was measured
 *   - WHY it matters for this specific query
 *   - WHERE the data came from (exact source, not "GitHub")
 *   - HOW confident the system is in this measurement
 *   - WHAT would have changed the result
 *
 * Displayed to the user as a "Scoring Transparency Card" per candidate.
 * This is NOT a debug log — it's written in plain language for recruiters.
 */

import type { DeepProfileAnalysis } from "./profile-analyzer";
import type { QueryAnalysis } from "./query-analyzer";
import type { ScoreDimension } from "./ranking";
import type { CognitiveStyleProfile } from "./cognitive-style-analyzer";
import type { AttributionTable } from "./attribution-table";
import type { RiskAuditReport } from "./risk-auditor";
import type { CounterfactualStabilityReport } from "./counterfactual-twins";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DataSource =
  | "github_commits"
  | "github_repos"
  | "github_prs"
  | "github_issues"
  | "github_gists"
  | "github_pinned"
  | "github_code_sample"
  | "github_topics"
  | "github_profile"
  | "package_registry"
  | "embedding_model"
  | "claude_analysis"
  | "heuristic"
  | "not_available";

export interface SignalExplanation {
  /** The signal name (plain English, not a variable name) */
  signal: string;
  /** Why this specific signal matters for THIS query */
  whyItMatters: string;
  /** Exactly where this data came from */
  dataSource: DataSource;
  /** Human-readable source description: "12 commits to huggingface/transformers" */
  sourceDescription: string;
  /** The raw value observed */
  observedValue: string;
  /** How this observation was interpreted */
  interpretation: string;
  /** Confidence in this signal (0–100) */
  confidence: number;
  /** What would have changed this assessment */
  whatWouldChange: string;
  /** Whether this signal was actually available (false = estimated/missing) */
  dataAvailable: boolean;
}

export interface EvaluationDimension {
  /** Dimension name */
  name: string;
  /** Plain-English label */
  label: string;
  /** Score for this dimension (0–100) */
  score: number;
  /** Weight in final score */
  weight: number;
  /** Points contributed to final score */
  contribution: number;
  /** Why this dimension is in the scoring model */
  whyInModel: string;
  /** The signals that fed this dimension */
  signals: SignalExplanation[];
  /** Overall confidence in this dimension's score */
  dimensionConfidence: number;
  /** What data would have made this score more accurate */
  dataMissing: string | null;
}

export interface MissingSkillExplanation {
  skill: string;
  /** Why this skill is required for this query */
  whyRequired: string;
  /** What the candidate has instead (if anything adjacent) */
  whatTheyHave: string | null;
  /** Specific evidence searched but not found */
  whereSearched: string[];
  /** How certain we are the skill is missing (vs. just not visible) */
  certaintyOfAbsence: "certain" | "likely" | "uncertain";
  /** Could they acquire this skill given their current base? */
  acquisitionPotential: "high" | "medium" | "low";
  /** Estimated weeks to competency given their existing knowledge */
  estimatedWeeksToCompetency: number | null;
}

export interface EvaluationTransparencyCard {
  candidateId: string;

  // ── What was evaluated ────────────────────────────────────────────────────
  /** Plain-English statement of what the system evaluated */
  evaluationStatement: string;
  /** Total signals collected */
  totalSignalsCollected: number;
  /** Signals used in final score */
  signalsUsedInScore: number;
  /** Signals discarded (demographic/bias) */
  signalsDiscarded: number;
  /** Discarded signal reasons */
  discardedSignalReasons: string[];

  // ── Per-dimension breakdown ───────────────────────────────────────────────
  dimensions: EvaluationDimension[];

  // ── Missing skills ────────────────────────────────────────────────────────
  missingSkills: MissingSkillExplanation[];

  // ── Data quality ──────────────────────────────────────────────────────────
  dataQuality: {
    /** Overall data completeness (0–100) */
    completeness: number;
    /** Which data sources were available */
    availableSources: DataSource[];
    /** Which data sources were missing */
    missingSources: DataSource[];
    /** How this affects score reliability */
    reliabilityNote: string;
  };

  // ── Score confidence ──────────────────────────────────────────────────────
  scoreConfidence: {
    /** Overall confidence in the final score (0–100) */
    overall: number;
    /** The single biggest uncertainty */
    biggestUncertainty: string;
    /** What would make this score more reliable */
    wouldImproveWith: string[];
  };

  // ── Bias check summary ────────────────────────────────────────────────────
  biasCheckSummary: {
    /** What demographic fields were found and stripped */
    stripped: string[];
    /** Counterfactual stability result */
    stabilityResult: string;
    /** Plain English statement for the user */
    plainStatement: string;
  };

  // ── Cognitive style integration ────────────────────────────────────────────
  cognitiveStyleSummary: {
    primaryStyle: string;
    relevanceToRole: string;
    keyInsight: string;
  } | null;

  /** Full plain-English explanation suitable for showing to the recruiter */
  plainEnglishSummary: string;
}

// ─── Signal Builders ──────────────────────────────────────────────────────────

function buildDimensionSignals(
  dimension: ScoreDimension,
  profile: DeepProfileAnalysis,
  query: QueryAnalysis
): SignalExplanation[] {
  const signals: SignalExplanation[] = [];

  switch (dimension.name) {
    case "niche_fit":
      signals.push({
        signal: "Commit history in query-specific niche",
        whyItMatters: `We searched for commits to repos related to: ${query.requiredSkills.slice(0, 3).join(", ")}`,
        dataSource: "github_commits",
        sourceDescription: `${profile.deepGithub.totalNicheCommits} commits found in niche repos (${profile.deepGithub.recentNicheCommits} in last 12 months)`,
        observedValue: `${profile.deepGithub.totalNicheCommits} niche commits across ${profile.deepGithub.nicheRepos.length} repos`,
        interpretation: profile.deepGithub.totalNicheCommits > 20
          ? "Strong evidence of active work in this domain"
          : profile.deepGithub.totalNicheCommits > 5
          ? "Some evidence of work in this domain"
          : "Limited direct niche commit evidence",
        confidence: profile.deepGithub.totalNicheCommits > 10 ? 85 : 50,
        whatWouldChange: "More commits to niche repos or longer repo history would increase confidence",
        dataAvailable: true,
      });

      if (profile.nicheFit) {
        signals.push({
          signal: "Direct requirements match assessment",
          whyItMatters: "Claude analyzed whether their actual work meets each specific requirement",
          dataSource: "claude_analysis",
          sourceDescription: `${profile.nicheFit.requirementsMet.length} requirements met, ${profile.nicheFit.requirementsNotMet.length} gaps identified`,
          observedValue: `Fit level: ${profile.nicheFit.fitLevel}, depth: ${profile.nicheFit.depthLevel}`,
          interpretation: profile.nicheFit.nicheSummary,
          confidence: 75,
          whatWouldChange: "Additional code samples or more detailed READMEs would improve accuracy",
          dataAvailable: true,
        });
      }
      break;

    case "craft_depth":
      signals.push({
        signal: "Real code file analysis",
        whyItMatters: "We sampled actual source files to evaluate code quality, not just repo descriptions",
        dataSource: "github_code_sample",
        sourceDescription: `${profile.codeQuality.sampledFiles.length} source files analyzed from top repos`,
        observedValue: `Code quality score: ${profile.codeQualityScore}/10, production grade: ${profile.isProductionGrade}`,
        interpretation: profile.codeQuality.greenFlags.length > 0
          ? `Positive signals: ${profile.codeQuality.greenFlags.slice(0, 2).join("; ")}`
          : "No strong positive code quality signals found",
        confidence: profile.codeQuality.sampledFiles.length > 2 ? 80 : 40,
        whatWouldChange: "More source files sampled would increase confidence in this score",
        dataAvailable: profile.codeQuality.sampledFiles.length > 0,
      });

      if (profile.codeQuality.redFlags.length > 0) {
        signals.push({
          signal: "Code quality risk indicators",
          whyItMatters: "Patterns that suggest potential quality issues in production contexts",
          dataSource: "github_code_sample",
          sourceDescription: `${profile.codeQuality.redFlags.length} risk patterns detected`,
          observedValue: profile.codeQuality.redFlags.join("; "),
          interpretation: "These patterns were observed in sampled files and may not be representative",
          confidence: 60,
          whatWouldChange: "Reviewing more files would clarify whether these are isolated instances",
          dataAvailable: true,
        });
      }
      break;

    case "teaching":
      signals.push({
        signal: "Public technical writing presence",
        whyItMatters: "Engineers who explain their work publicly tend to have clearer mental models",
        dataSource: profile.socialPresence.blog ? "github_profile" : "not_available",
        sourceDescription: profile.socialPresence.blog
          ? `Blog/writing found: ${profile.socialPresence.blog.url}`
          : "No public writing presence found",
        observedValue: profile.socialPresence.hasWritingPresence ? "Writing presence detected" : "No writing found",
        interpretation: profile.socialPresence.hasWritingPresence
          ? "Has public channel for sharing knowledge"
          : "No evidence of public knowledge sharing",
        confidence: 90,
        whatWouldChange: "Nothing — presence/absence of writing is a direct signal",
        dataAvailable: true,
      });
      break;

    case "trending_contribution":
      signals.push({
        signal: "Contributions to currently trending repos",
        whyItMatters: `Are they actively engaged with what's happening RIGHT NOW in ${query.domains[0] ?? "this domain"}?`,
        dataSource: "github_prs",
        sourceDescription: dimension.evidence,
        observedValue: dimension.label,
        interpretation: dimension.score > 50
          ? "Actively engaged with the live ecosystem — skills are current"
          : "No recent contributions to trending repos found",
        confidence: 85,
        whatWouldChange: "Contributing to trending repos in this niche would significantly raise this score",
        dataAvailable: true,
      });
      break;

    default:
      signals.push({
        signal: dimension.label,
        whyItMatters: `This dimension contributes ${(dimension.weight * 100).toFixed(0)}% of the total score`,
        dataSource: "heuristic",
        sourceDescription: dimension.evidence,
        observedValue: `Score: ${dimension.score}/100`,
        interpretation: dimension.evidence,
        confidence: 70,
        whatWouldChange: "See evidence description above",
        dataAvailable: true,
      });
  }

  return signals;
}

// ─── Missing Skill Builder ────────────────────────────────────────────────────

function buildMissingSkillExplanation(
  skill: string,
  profile: DeepProfileAnalysis,
  query: QueryAnalysis
): MissingSkillExplanation {
  const skillLower = skill.toLowerCase();

  // What did we search?
  const searched = [
    `${profile.skills.length} explicit skill claims in profile`,
    `${profile.domains.length} domain descriptions`,
    `${profile.deepGithub.nicheRepos.length} niche repos`,
    `${profile.deepGithub.totalNicheCommits} commit messages`,
    profile.codeQuality.sampledFiles.length > 0
      ? `${profile.codeQuality.sampledFiles.length} code files`
      : null,
  ].filter(Boolean) as string[];

  // What adjacent skill do they have?
  const adjacent = profile.skills.find((s) => {
    const sLower = s.name.toLowerCase();
    return sLower.split(" ").some((w) => skillLower.includes(w) || w.includes(skillLower.split(" ")[0]));
  });

  // Estimate acquisition potential based on their existing domains
  const domainOverlap = query.domains.filter((d) =>
    profile.domains.some((pd) => pd.toLowerCase().includes(d.toLowerCase().split(" ")[0]))
  ).length;

  const acquisitionPotential: MissingSkillExplanation["acquisitionPotential"] =
    domainOverlap > 1 ? "high" : domainOverlap > 0 ? "medium" : "low";

  const estimatedWeeks =
    acquisitionPotential === "high" ? 4 :
    acquisitionPotential === "medium" ? 12 : null;

  return {
    skill,
    whyRequired: `Required because it's listed as a core skill for: ${query.intent}`,
    whatTheyHave: adjacent
      ? `${adjacent.name} (${adjacent.level}) — related but different`
      : null,
    whereSearched: searched,
    certaintyOfAbsence: profile.deepGithub.nicheRepos.length > 3 ? "likely" : "uncertain",
    acquisitionPotential,
    estimatedWeeksToCompetency: estimatedWeeks,
  };
}

// ─── Data Quality Assessor ────────────────────────────────────────────────────

function assessDataQuality(profile: DeepProfileAnalysis): EvaluationTransparencyCard["dataQuality"] {
  const available: DataSource[] = ["github_profile", "github_repos"];
  const missing: DataSource[] = [];

  if (profile.deepGithub.commitSamples?.length ?? 0 > 0) available.push("github_commits");
  else missing.push("github_commits");

  if (profile.deepGithub.prSamples?.length ?? 0 > 0) available.push("github_prs");
  else missing.push("github_prs");

  if (profile.deepGithub.issueSamples?.length ?? 0 > 0) available.push("github_issues");
  else missing.push("github_issues");

  if (profile.deepGithub.gistSamples?.length ?? 0 > 0) available.push("github_gists");
  else missing.push("github_gists");

  if (profile.codeQuality.sampledFiles.length > 0) available.push("github_code_sample");
  else missing.push("github_code_sample");

  if (profile.deepGithub.pinnedRepos.length > 0) available.push("github_pinned");
  else missing.push("github_pinned");

  if (profile.socialPresence.linkedin) available.push("github_profile");

  const completeness = Math.round((available.length / (available.length + missing.length)) * 100);
  const reliabilityNote = missing.length === 0
    ? "All expected data sources were available — high confidence score"
    : `Missing: ${missing.join(", ")} — these gaps add uncertainty to the score`;

  return { completeness, availableSources: available, missingSources: missing, reliabilityNote };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * buildTransparencyCard — the complete evaluation transparency report.
 *
 * Every signal used to rank this candidate is explained:
 * what it is, why it matters, where it came from, how confident we are,
 * and what would have changed the result.
 *
 * This is the "glass box" that makes the system accountable to the user.
 */
export function buildTransparencyCard(
  profile: DeepProfileAnalysis,
  query: QueryAnalysis,
  dimensions: ScoreDimension[],
  finalScore: number,
  missingSkillNames: string[],
  cognitiveStyle: CognitiveStyleProfile | null,
  counterfactual: CounterfactualStabilityReport,
  attribution: AttributionTable
): EvaluationTransparencyCard {

  const candidateId = `CND_${profile.username.slice(0, 8)}`;

  // Build per-dimension entries
  const evaluationDimensions: EvaluationDimension[] = dimensions.map((dim) => {
    const signals = buildDimensionSignals(dim, profile, query);
    const avgConfidence = signals.length > 0
      ? signals.reduce((a, s) => a + s.confidence, 0) / signals.length
      : 50;

    const whyInModel: Record<string, string> = {
      niche_fit: "The most important signal — does their actual work match what you need?",
      craft_depth: "Real code quality, not just language familiarity",
      teaching: "Engineers who teach have clearer mental models and are easier to work with",
      community: "Maintainers who respond to users build more reliable software",
      challenge_seeking: "Voluntarily choosing hard problems predicts performance on hard problems",
      consistency: "Long-term focus in a domain beats recent buzzword adoption",
      discovery_premium: "How hard was this person to find? Hidden talent = less competition",
      trending_contribution: "Are their skills current? Do they engage with what's happening now?",
    };

    return {
      name: dim.name,
      label: dim.label,
      score: dim.score,
      weight: dim.weight,
      contribution: Math.round(dim.score * dim.weight),
      whyInModel: whyInModel[dim.name] ?? "Contributes to overall candidate quality",
      signals,
      dimensionConfidence: Math.round(avgConfidence),
      dataMissing: signals.some((s) => !s.dataAvailable)
        ? signals.filter((s) => !s.dataAvailable).map((s) => s.signal).join(", ")
        : null,
    };
  });

  // Build missing skill entries
  const missingSkills = missingSkillNames.map((skill) =>
    buildMissingSkillExplanation(skill, profile, query)
  );

  // Data quality
  const dataQuality = assessDataQuality(profile);

  // Score confidence
  const avgDimConfidence = evaluationDimensions.reduce((a, d) => a + d.dimensionConfidence, 0) / evaluationDimensions.length;
  const scoreConfidence = {
    overall: Math.round(avgDimConfidence * (dataQuality.completeness / 100)),
    biggestUncertainty: dataQuality.missingSources.length > 0
      ? `${dataQuality.missingSources[0]} data was not available`
      : profile.deepGithub.totalNicheCommits === 0
      ? "No direct niche commits found — matching on adjacent signals"
      : "Score is well-supported by available data",
    wouldImproveWith: [
      ...dataQuality.missingSources.slice(0, 2).map((s) => `Access to ${s.replace(/_/g, " ")}`),
      profile.codeQuality.sampledFiles.length < 3 ? "More code file samples" : null,
    ].filter(Boolean) as string[],
  };

  // Bias check summary
  const biasCheckSummary = {
    stripped: attribution.hiddenPathFlags.length > 0
      ? attribution.hiddenPathFlags.map((f) => f.note)
      : ["No demographic signals found in technical evidence"],
    stabilityResult: counterfactual.testsRun > 0
      ? `${counterfactual.stabilityPercent.toFixed(1)}% stable across ${counterfactual.testsRun} demographic variants (CDI: ${counterfactual.causalDisparityIndex.toFixed(4)})`
      : "Demographic stability test not run for this candidate",
    plainStatement: counterfactual.stabilityVerdict === "STABLE"
      ? `✅ This candidate would receive essentially the same score regardless of their apparent gender, nationality, veteran status, or career gaps. The score reflects technical merit only.`
      : `⚠️ A small score variation was detected across demographic variants (CDI: ${counterfactual.causalDisparityIndex.toFixed(4)}). Manual review recommended.`,
  };

  // Cognitive style summary
  const cognitiveStyleSummary = cognitiveStyle ? {
    primaryStyle: cognitiveStyle.primaryStyle.replace(/_/g, " "),
    relevanceToRole: cognitiveStyle.bestFitProblemTypes
      .filter((t) => query.domains.some((d) => t.toLowerCase().includes(d.toLowerCase().split(" ")[0])))
      .slice(0, 1)[0] ?? "General engineering problem-solving",
    keyInsight: cognitiveStyle.cognitiveFingerprint,
  } : null;

  // Discarded signals
  const discardedSignals = [
    profile.followers > 0 ? `Follower count (${profile.followers}) — fame bias` : null,
    profile.company ? `Company affiliation (${profile.company}) — brand bias` : null,
    profile.location ? `Location (${profile.location}) — geographic bias` : null,
  ].filter(Boolean) as string[];

  // Plain English summary
  const topDims = [...evaluationDimensions]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  const plainEnglishSummary = [
    `This candidate scored ${finalScore}/100 for "${query.rewrite.expertQuery.slice(0, 60)}".`,
    ``,
    `The score was built from ${evaluationDimensions.length} dimensions. The biggest contributors were:`,
    ...topDims.map((d) => `  • ${d.label} (${d.contribution} pts): ${d.signals[0]?.interpretation ?? d.name}`),
    ``,
    missingSkills.length > 0
      ? `${missingSkills.length} required skill(s) were not found: ${missingSkills.map((s) => s.skill).join(", ")}.`
      : `All required skills were found or closely matched.`,
    ``,
    `Data completeness: ${dataQuality.completeness}%. Score confidence: ${scoreConfidence.overall}%.`,
    ``,
    biasCheckSummary.plainStatement,
  ].join("\n");

  // Signals discarded count
  const totalSignals = evaluationDimensions.reduce((a, d) => a + d.signals.length, 0);

  return {
    candidateId,
    evaluationStatement: `Evaluated ${profile.username} for "${query.intent}" using ${totalSignals} signals across ${evaluationDimensions.length} dimensions. ${discardedSignals.length} demographic signals were identified and excluded.`,
    totalSignalsCollected: totalSignals + discardedSignals.length,
    signalsUsedInScore: totalSignals,
    signalsDiscarded: discardedSignals.length,
    discardedSignalReasons: discardedSignals,
    dimensions: evaluationDimensions,
    missingSkills,
    dataQuality,
    scoreConfidence,
    biasCheckSummary,
    cognitiveStyleSummary,
    plainEnglishSummary,
  };
}
