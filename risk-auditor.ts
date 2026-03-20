/**
 * RISK AUDITOR AGENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the "Negative Match" approach from:
 *   XAI in Recruitment: Explainable Gaps, Not Fits, Feb 2026.
 *
 * Core insight from the research:
 *   "Identifying Gaps is less biased than identifying Fits."
 *   When an AI looks for what's PRESENT, it tends to reward recognizable
 *   signals (famous employers, prestigious universities, familiar tool names).
 *   When an AI looks for what's MISSING, it forces comparison to objective
 *   requirements rather than subjective pattern-matching on prestige.
 *
 * This agent performs a "Negative Match":
 *   Input:  JD Requirements + Scrubbed (anonymized) technical profile
 *   Prompt: "Act as a critical hiring manager. Find exactly what is MISSING
 *            from this candidate's profile relative to the JD. Do not guess;
 *            only cite missing keywords or demonstrated capabilities."
 *   Output: Structured risk register with severity ratings.
 *
 * Risk taxonomy (4 levels):
 *   BLOCKING    — Requirement explicitly stated as mandatory; candidate has
 *                  no evidence. Hiring would be a risk without validation.
 *   SIGNIFICANT — Requirement important but not explicitly mandatory; gap is
 *                  material. Would need on-the-job ramp-up.
 *   MINOR       — Nice-to-have requirement not met; negligible impact.
 *   LATENT      — Requirement is met but at lower depth than JD implies.
 *                  "Has Python" but JD needs "Python at scale" level.
 *
 * The "line-level citation" requirement:
 *   Per the research, every identified risk must cite the specific JD line
 *   (or query signal) that identified the gap — not a general observation.
 *   Example: "Risk: candidate lists 'Database Management' but lacks specific
 *   'NoSQL/MongoDB' experience mentioned in [required skills: MongoDB]."
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "./bias-free-evaluator";
import type { DeepProfileAnalysis } from "./profile-analyzer";
import type { QueryAnalysis } from "./query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskSeverity = "BLOCKING" | "SIGNIFICANT" | "MINOR" | "LATENT";
export type RiskCategory =
  | "skill_missing"         // explicit skill not found at all
  | "depth_insufficient"    // skill present but at wrong depth/scale
  | "recency_stale"         // skill present but evidence is old
  | "scale_mismatch"        // experience exists but at different scale
  | "domain_adjacent"       // adjacent domain, not the exact one required
  | "evidence_thin"         // claim exists but no corroborating evidence
  | "unknown";

export interface RiskEntry {
  /** The specific JD requirement this risk relates to */
  jdRequirement: string;
  /** Which query signal (line) identified this gap */
  sourceSignal: string;
  /** What the candidate has (or doesn't have) */
  candidateHas: string;
  /** The specific gap statement */
  gapStatement: string;
  /** Risk severity */
  severity: RiskSeverity;
  /** Risk category */
  category: RiskCategory;
  /** Impact on hiring decision if not addressed */
  hiringImpact: string;
  /** How to validate or close this gap during hiring */
  validationApproach: string;
  /** Probability this is a real gap (vs misdetection) */
  confidence: "high" | "medium" | "low";
  /** Whether this risk is mitigatable through learning */
  isMitigatable: boolean;
  /** Estimated ramp-up time if hired with this gap */
  estimatedRampUpWeeks: number | null;
}

export interface RiskAuditReport {
  candidateId: string;
  requirementsAudited: number;

  /** All identified risks, sorted by severity */
  risks: RiskEntry[];

  /** Blocking risks — these should stop progression without validation */
  blockingRisks: RiskEntry[];
  /** Significant risks — material gaps worth discussing in interview */
  significantRisks: RiskEntry[];
  /** Minor and latent risks — low impact, informational only */
  minorRisks: RiskEntry[];

  /** Risk score: 0 = no risks, 100 = all requirements are gaps */
  riskScore: number;

  /** Overall risk verdict */
  riskVerdict: "LOW_RISK" | "MODERATE_RISK" | "HIGH_RISK" | "BLOCKING";

  /** The 3 most important interview questions to probe these gaps */
  suggestedInterviewProbes: string[];

  /** Whether the candidate is still worth pursuing despite risks */
  isWorthPursuing: boolean;

  /** One-paragraph risk summary for the recruiter */
  riskSummary: string;
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────
// The negative-match prompt — asks Claude to find what's MISSING, not what fits.
// Explicitly instructs it not to guess, only cite missing keywords.

const RISK_AUDITOR_SYSTEM = `You are a critical hiring manager performing a "negative match" audit.
Your job is to find GAPS, not confirm fits.

Critical rules:
1. Only report risks where you can cite the specific JD requirement that isn't met
2. "Has Python" when the JD needs "Python at 50k+ RPS scale" is a LATENT risk, not a full match
3. Do NOT guess about skills not evidenced in the profile
4. Do NOT penalize for skills not mentioned in the JD
5. Do NOT use employer names or universities to infer skills (that is a hidden path)
6. Every risk must cite the source: "The JD requires X; candidate only demonstrates Y"

Your output will be presented to the recruiter as a risk register, not a rejection.
Frame risks constructively: what would need validation, not why to reject.`;

// ─── Profile Scrubber ─────────────────────────────────────────────────────────
// Before sending to the risk auditor, strip everything except technical signals.
// This enforces the "scrubbed JSON" input requirement from the research.

function scrubProfileForRiskAudit(profile: DeepProfileAnalysis): string {
  return [
    `=== TECHNICAL PROFILE (demographic signals removed) ===`,
    `Headline: ${profile.headline}`,
    `Domains: ${profile.domains.join(", ")}`,
    `Languages used: ${Object.keys(profile.languages).join(", ")}`,
    ``,
    `Skills with evidence:`,
    ...profile.skills.map((s) => `  • ${s.name} (${s.level}): ${s.evidence}`),
    ``,
    `Projects:`,
    ...profile.projects.map((p) => `  • ${p.name}: ${p.description} | Impact: ${p.impact} | Tech: ${p.technologies.join(", ")}`),
    ``,
    `Technical fingerprint:`,
    ...profile.technicalFingerprint.map((f) => `  • ${f}`),
    ``,
    `Niche commit evidence:`,
    `  Total niche commits: ${profile.deepGithub.totalNicheCommits}`,
    `  Recent (12mo): ${profile.deepGithub.recentNicheCommits}`,
    `  Niche repos: ${profile.deepGithub.nicheRepos.join(", ") || "none identified"}`,
    ``,
    `Code quality:`,
    `  Score: ${profile.codeQualityScore}/10`,
    `  Production-grade: ${profile.isProductionGrade}`,
    `  Green flags: ${profile.codeQuality.greenFlags.join("; ") || "none"}`,
    `  Red flags: ${profile.codeQuality.redFlags.join("; ") || "none"}`,
    ``,
    ...(profile.nicheFit ? [
      `Niche fit assessment:`,
      `  Fit level: ${profile.nicheFit.fitLevel}`,
      `  Depth: ${profile.nicheFit.depthLevel}`,
      `  Requirements NOT met: ${profile.nicheFit.requirementsNotMet.map((r) => r.requirement).join("; ") || "none noted"}`,
    ] : []),
  ].join("\n");
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * runRiskAudit — the Negative Match risk analysis.
 *
 * Asks Claude to act as a critical hiring manager and find EXACTLY what is
 * missing from this candidate's profile relative to the job requirements.
 * Every identified risk cites the specific requirement line that triggered it.
 *
 * Per XAI in Recruitment research: gaps-based analysis is less biased than
 * fits-based analysis because it forces comparison to objective criteria
 * rather than subjective prestige pattern-matching.
 */
export async function runRiskAudit(
  profile: DeepProfileAnalysis,
  query: QueryAnalysis
): Promise<RiskAuditReport> {
  const scrubbed = scrubProfileForRiskAudit(profile);
  const requirementLines = [
    ...query.requiredSkills.map((s, i) => `REQ-${i + 1}: ${s}`),
    ...query.domains.map((d, i) => `DOM-${i + 1}: Working knowledge of domain: ${d}`),
    ...(query.seniority !== "any" ? [`SEN-1: Seniority level: ${query.seniority}`] : []),
    ...(query.languages.length > 0 ? [`LANG-1: Uses language(s): ${query.languages.join(", ")}`] : []),
    ...query.bonusSignals.slice(0, 3).map((b, i) => `BONUS-${i + 1}: ${b}`),
  ];

  interface RawRisk {
    jdRequirement: string;
    sourceSignal: string;
    candidateHas: string;
    gapStatement: string;
    severity: RiskSeverity;
    category: RiskCategory;
    hiringImpact: string;
    validationApproach: string;
    confidence: "high" | "medium" | "low";
    isMitigatable: boolean;
    estimatedRampUpWeeks: number | null;
  }

  interface RawOutput {
    risks: RawRisk[];
    suggestedInterviewProbes: string[];
    isWorthPursuing: boolean;
    riskSummary: string;
  }

  const raw = await callClaudeJSON<RawOutput>(
    `Perform a NEGATIVE MATCH audit. Find what is MISSING from this candidate's profile.

JD REQUIREMENTS (cite these by ID in your risks):
${requirementLines.join("\n")}

SCRUBBED TECHNICAL PROFILE:
${scrubbed}

For each gap you find:
- State the JD requirement ID that isn't fully met
- Cite what the candidate DOES have (even if insufficient)
- State the specific gap precisely: "Candidate has X but JD requires Y"
- Classify severity and estimate ramp-up

If a requirement is fully met, do NOT include it in risks.
Focus only on genuine gaps, not style preferences.

Return JSON:
{
  "risks": [
    {
      "jdRequirement": "exact requirement from the JD lines above",
      "sourceSignal": "REQ-1|DOM-2|etc — which requirement ID",
      "candidateHas": "what they actually have (even if insufficient)",
      "gapStatement": "Candidate has X but JD requires Y (cite specific mismatch)",
      "severity": "BLOCKING|SIGNIFICANT|MINOR|LATENT",
      "category": "skill_missing|depth_insufficient|recency_stale|scale_mismatch|domain_adjacent|evidence_thin",
      "hiringImpact": "what happens if hired with this gap",
      "validationApproach": "how to validate or close this in interview/trial",
      "confidence": "high|medium|low",
      "isMitigatable": true/false,
      "estimatedRampUpWeeks": <number or null>
    }
  ],
  "suggestedInterviewProbes": [
    "specific interview question to probe the most important gap",
    "another question",
    "third question"
  ],
  "isWorthPursuing": true/false,
  "riskSummary": "2-3 sentence paragraph summarizing the risk profile for the recruiter"
}`,
    {
      system: RISK_AUDITOR_SYSTEM,
      operation: "niche_fit",
      maxTokens: 2000,
    }
  );

  const risks = raw.risks ?? [];
  const blocking = risks.filter((r) => r.severity === "BLOCKING");
  const significant = risks.filter((r) => r.severity === "SIGNIFICANT");
  const minor = risks.filter((r) => r.severity === "MINOR" || r.severity === "LATENT");

  const riskScore = Math.min(100, Math.round(
    blocking.length * 30 +
    significant.length * 15 +
    minor.length * 5
  ));

  const riskVerdict =
    blocking.length > 0 ? "BLOCKING" :
    riskScore >= 50 ? "HIGH_RISK" :
    riskScore >= 25 ? "MODERATE_RISK" : "LOW_RISK";

  return {
    candidateId: `CND_${profile.username.slice(0, 8)}`,
    requirementsAudited: requirementLines.length,
    risks: risks.sort((a, b) => {
      const order: Record<RiskSeverity, number> = { BLOCKING: 0, SIGNIFICANT: 1, MINOR: 2, LATENT: 3 };
      return order[a.severity] - order[b.severity];
    }),
    blockingRisks: blocking,
    significantRisks: significant,
    minorRisks: minor,
    riskScore,
    riskVerdict,
    suggestedInterviewProbes: raw.suggestedInterviewProbes?.slice(0, 3) ?? [],
    isWorthPursuing: raw.isWorthPursuing ?? riskVerdict !== "BLOCKING",
    riskSummary: raw.riskSummary ?? "Risk analysis not available.",
  };
}
