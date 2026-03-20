/**
 * STRONG WHY GENERATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces the single most important output in the entire pipeline:
 * the "strong why" — an explicit, evidence-grounded explanation of exactly
 * why this candidate ranked where they did.
 *
 * Not generic praise. Not a list of skills. Not a score summary.
 * A specific argument, like a prosecutor's opening statement:
 *
 *   "Ranked #1 because [specific verifiable thing they did] demonstrates
 *    [specific capability the query needs] better than anyone else in this
 *    result set. The evidence is [exact commit/repo/PR]. Competitors ranked
 *    lower because [what they have that others don't]."
 *
 * The strong why has 5 components:
 *
 *   1. THE VERDICT    — one sentence, the conclusion
 *   2. THE PROOF      — 2-3 specific verifiable evidence items
 *   3. THE EDGE       — what makes them better than similarly-scored candidates
 *   4. THE CAVEAT     — the honest limitation (what's missing or uncertain)
 *   5. THE QUESTION   — the one interview question that would validate or
 *                        invalidate this ranking
 *
 * Why a "strong why" matters:
 *   Recruiters get thousands of "strong match!" signals that mean nothing.
 *   A specific, falsifiable argument forces the system to commit to a claim
 *   that can be verified — which is what makes it trustworthy.
 *
 * Cognitive style integration:
 *   The strong why incorporates HOW the candidate thinks, not just WHAT they
 *   know. "Ranked #1 not just because they know Rust, but because their commit
 *   history shows they reason about ownership before touching the keyboard —
 *   which is what this role actually needs."
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "./bias-free-evaluator";
import type { DeepProfileAnalysis } from "./profile-analyzer";
import type { QueryAnalysis } from "./query-analyzer";
import type { ScoreDimension } from "./ranking";
import type { CognitiveStyleProfile } from "./cognitive-style-analyzer";
import type { AttributionTable } from "./attribution-table";
import type { RiskAuditReport } from "./risk-auditor";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  /** The specific, verifiable claim */
  claim: string;
  /** Direct URL or reference to the evidence */
  sourceUrl: string | null;
  /** The exact artifact: commit SHA, repo name, PR link, file path */
  artifact: string | null;
  /** How strong this evidence is */
  strength: "definitive" | "strong" | "supporting";
}

export interface StrongWhy {
  rank: number;

  // ── The 5 components ───────────────────────────────────────────────────────

  /** The verdict: one sentence, the complete argument */
  verdict: string;

  /** 2-3 specific, verifiable evidence items */
  proof: EvidenceItem[];

  /** What gives them an edge over similarly-scored candidates */
  edge: string;

  /**
   * The honest caveat — what's uncertain, missing, or could reverse
   * this ranking if it turned out differently.
   * Written as: "This ranking would change if..."
   */
  caveat: string;

  /**
   * The single most important interview question to validate this ranking.
   * Written to specifically probe the highest-confidence claim.
   */
  validationQuestion: string;

  // ── Cognitive style dimension ─────────────────────────────────────────────

  /**
   * How their thinking style (not just skills) maps to this role.
   * null if cognitive style analysis wasn't run.
   */
  cognitiveAlignment: string | null;

  /**
   * A specific example of HOW they think, extracted from their commit/PR/code.
   * This is not a skill claim — it's a window into their mind.
   */
  thinkingExample: string | null;

  // ── Missing skills framing ────────────────────────────────────────────────

  /**
   * The missing skills stated as specific, actionable gaps —
   * not generic "lacks X" but "needs X to do Y in this role".
   */
  gapsAsActionableRisks: Array<{
    gap: string;
    impactIfUnaddressed: string;
    probeQuestion: string;
  }>;

  // ── Comparison framing ────────────────────────────────────────────────────

  /** Why they ranked above whoever came just below them */
  whyBetterThanNext: string | null;

  // ── Confidence ────────────────────────────────────────────────────────────

  /** How confident is this "why" in the ranking? (0–100) */
  confidence: number;

  /** What would flip this ranking (the falsifiability test) */
  wouldFlipIf: string;
}

// ─── Evidence Extractor ───────────────────────────────────────────────────────
// Pulls the most specific, verifiable evidence items from the profile.

function extractTopEvidence(
  profile: DeepProfileAnalysis,
  query: QueryAnalysis,
  attribution: AttributionTable
): EvidenceItem[] {
  const items: EvidenceItem[] = [];

  // Evidence tier 1: Direct attribution rows with full_match or exceeds
  for (const row of attribution.rows.slice(0, 3)) {
    if (row.status === "full_match" || row.status === "exceeds") {
      items.push({
        claim: `${row.requirement}: ${row.extraction}`,
        sourceUrl: row.extractionSource?.startsWith("http") ? row.extractionSource : null,
        artifact: row.extractionSource,
        strength: "definitive",
      });
    }
  }

  // Evidence tier 2: Niche repos with commits
  for (const repo of profile.deepGithub.nicheRepos.slice(0, 2)) {
    items.push({
      claim: `Active niche contributor: committed to ${repo}`,
      sourceUrl: `https://github.com/${repo}`,
      artifact: repo,
      strength: "strong",
    });
  }

  // Evidence tier 3: Code quality green flags
  for (const flag of profile.codeQuality.greenFlags.slice(0, 2)) {
    items.push({
      claim: flag,
      sourceUrl: profile.codeQuality.sampledFiles[0]
        ? `https://github.com/${profile.username}/${profile.codeQuality.sampledFiles[0]}`
        : null,
      artifact: profile.codeQuality.sampledFiles[0] ?? null,
      strength: "supporting",
    });
  }

  // Evidence tier 4: Niche fit direct evidence
  for (const e of (profile.nicheFit?.directEvidence ?? []).slice(0, 2)) {
    if (e.strength === "strong") {
      items.push({
        claim: e.description,
        sourceUrl: e.url,
        artifact: e.url,
        strength: "strong",
      });
    }
  }

  return items.slice(0, 5);
}

// ─── Claude Strong Why ────────────────────────────────────────────────────────

export async function generateStrongWhy(
  rank: number,
  profile: DeepProfileAnalysis,
  query: QueryAnalysis,
  dimensions: ScoreDimension[],
  finalScore: number,
  cognitiveStyle: CognitiveStyleProfile | null,
  attribution: AttributionTable,
  riskAudit: RiskAuditReport,
  nextCandidateScore: number | null
): Promise<StrongWhy> {

  const evidence = extractTopEvidence(profile, query, attribution);

  const topDims = [...dimensions]
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .slice(0, 3);

  const blockingGaps = riskAudit.blockingRisks.map((r) => ({
    gap: r.gapStatement,
    req: r.jdRequirement,
    impact: r.hiringImpact,
    probe: r.validationApproach,
  }));

  const significantGaps = riskAudit.significantRisks.slice(0, 2).map((r) => ({
    gap: r.gapStatement,
    req: r.jdRequirement,
    impact: r.hiringImpact,
    probe: r.validationApproach,
  }));

  const cogSection = cognitiveStyle ? `
COGNITIVE STYLE:
Primary style: ${cognitiveStyle.primaryStyle}
Cognitive fingerprint: ${cognitiveStyle.cognitiveFingerprint}
Best commit message (shows their thinking): ${cognitiveStyle.commitAnalysis.bestCommitMessage ?? "N/A"}
Thinking patterns: ${cognitiveStyle.thoughtPatterns.slice(0, 3).map((p) => `${p.pattern} (${p.strength}/10): ${p.example ?? ""}`).join(" | ")}
Best fit problems: ${cognitiveStyle.bestFitProblemTypes.join(", ")}
Uncertainty approach: ${cognitiveStyle.uncertaintyApproach}` : "";

  const prompt = `You are writing the definitive argument for why this candidate ranked #${rank}.

Be specific. Be falsifiable. Use only the evidence provided.
Never use generic phrases like "strong background" or "extensive experience."
Every claim must cite something specific from the data.

QUERY: "${query.rewrite.expertQuery}"
CANDIDATE SCORE: ${finalScore}/100 (Rank #${rank})
${nextCandidateScore !== null ? `NEXT CANDIDATE SCORE: ${nextCandidateScore}/100` : ""}

TOP SCORING DIMENSIONS:
${topDims.map((d) => `• ${d.label} (${d.score}/100, ${(d.weight * 100).toFixed(0)}% weight): ${d.evidence}`).join("\n")}

EVIDENCE AVAILABLE:
${evidence.map((e) => `• [${e.strength}] ${e.claim}${e.artifact ? ` — ${e.artifact}` : ""}`).join("\n")}

ATTRIBUTION TABLE TOP ROWS:
${attribution.rows.slice(0, 3).map((r) => `• ${r.requirement}: "${r.extraction}" → ${r.status} (+${r.contribution.toFixed(0)} pts)`).join("\n")}

GAPS:
${blockingGaps.length > 0 ? `BLOCKING: ${blockingGaps.map((g) => g.gap).join("; ")}` : "No blocking gaps"}
${significantGaps.length > 0 ? `SIGNIFICANT: ${significantGaps.map((g) => g.gap).join("; ")}` : "No significant gaps"}
${cogSection}

Return JSON:
{
  "verdict": "one sentence that is the complete argument for this ranking — specific, falsifiable, cites actual evidence",
  "proof": [
    {
      "claim": "specific verifiable claim",
      "sourceUrl": "URL if available from the evidence above, else null",
      "artifact": "repo name, commit reference, or specific identifier",
      "strength": "definitive|strong|supporting"
    }
  ],
  "edge": "what makes them better than someone who scored 5 points lower — specific to THIS query",
  "caveat": "This ranking would change if... [specific falsifiable condition]",
  "validationQuestion": "The single most important interview question to probe the top claim. Must be specific to their work, not generic.",
  "cognitiveAlignment": ${cognitiveStyle ? `"how their ${cognitiveStyle.primaryStyle} cognitive style maps to the demands of this specific role"` : "null"},
  "thinkingExample": ${cognitiveStyle?.commitAnalysis.bestCommitMessage ? `"a specific example from their commit/PR/code that shows HOW they think, not just WHAT they know"` : "null"},
  "gapsAsActionableRisks": [
    {
      "gap": "the gap stated as a specific missing capability",
      "impactIfUnaddressed": "concrete impact on the role if this gap persists",
      "probeQuestion": "interview question to assess severity of this gap"
    }
  ],
  "whyBetterThanNext": ${nextCandidateScore !== null ? `"specific reason they ranked above the #${rank + 1} candidate"` : "null"},
  "confidence": <0-100, how confident is this ranking argument>,
  "wouldFlipIf": "the single condition that would most change this ranking"
}`;

  const result = await callClaudeJSON<Omit<StrongWhy, "rank">>(prompt, {
    system: BIAS_FREE_SYSTEM_PROMPT,
    operation: "ranking_narrative",
    maxTokens: 1800,
  });

  return { rank, ...result };
}

/**
 * generateBatchStrongWhys — generates strong whys for top N candidates.
 * Passes each candidate's next-candidate score so the "why better than next"
 * comparison is grounded in real data.
 */
export async function generateBatchStrongWhys(
  candidates: Array<{
    rank: number;
    profile: DeepProfileAnalysis;
    query: QueryAnalysis;
    dimensions: ScoreDimension[];
    finalScore: number;
    cognitiveStyle: CognitiveStyleProfile | null;
    attribution: AttributionTable;
    riskAudit: RiskAuditReport;
  }>,
  limit = 8
): Promise<StrongWhy[]> {
  const top = candidates.slice(0, limit);

  const results = await Promise.allSettled(
    top.map((c, i) =>
      generateStrongWhy(
        c.rank,
        c.profile,
        c.query,
        c.dimensions,
        c.finalScore,
        c.cognitiveStyle,
        c.attribution,
        c.riskAudit,
        top[i + 1]?.finalScore ?? null
      )
    )
  );

  return results
    .filter((r): r is PromiseFulfilledResult<StrongWhy> => r.status === "fulfilled")
    .map((r) => r.value);
}
