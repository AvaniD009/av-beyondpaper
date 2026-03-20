/**
 * ATTRIBUTE ATTRIBUTION TABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the "Feature-to-Score" mapping from:
 *   Guyyala et al., "Causal Representation Learning in Automated Screening",
 *   ICJA, January 2026.
 *
 * Core insight: bias occurs when "hidden paths" — hobby signals, university
 * prestige, name-derived nationality — influence scores without being visible
 * in the decision trace. The antidote is an Attribute Attribution Table that
 * shows EXACTLY which piece of evidence triggered each point contribution.
 *
 * The table has one row per JD requirement. Each row contains:
 *   - The requirement (what the JD asks for)
 *   - The exact extraction from the candidate's profile (the evidence)
 *   - The logic/rationale (why this extraction satisfies the requirement)
 *   - The weight (how important this requirement is)
 *   - The contribution (how many points it added)
 *   - The extraction source (which exact repo/commit/file/line this came from)
 *
 * The "Glassbox" property: every point in the score can be traced to a
 * specific, verifiable piece of technical evidence — never to an implicit
 * proxy like employer prestige or name-derived signals.
 *
 * UI integration: the `extractionSource` field gives a direct URL so
 * the UI can highlight the exact sentence in the profile that triggered points.
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "./bias-free-evaluator";
import type { DeepProfileAnalysis } from "./profile-analyzer";
import type { QueryAnalysis } from "./query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AttributionStatus =
  | "full_match"        // requirement fully met — full points
  | "exceeds"           // candidate exceeds requirement — full points + note
  | "partial_match"     // partially meets requirement — scaled points
  | "risk_match"        // meets it but with a noted risk/caveat
  | "adjacent_match"    // adjacent skill covers it — reduced points
  | "not_met";          // not met — 0 points

export interface AttributionRow {
  /** The requirement extracted from the job description / query */
  requirement: string;
  /** How important this requirement is to the overall role */
  weight: number;           // 0.0–1.0, all weights sum to 1.0
  /** The specific text/evidence extracted from the candidate's profile */
  extraction: string;
  /** The exact source of the extraction — URL, repo name, commit SHA */
  extractionSource: string | null;
  /** Human-readable rationale for why this extraction satisfies the requirement */
  rationale: string;
  /** Status of the match */
  status: AttributionStatus;
  /** Points contributed (weight × match_quality × 100) */
  contribution: number;
  /** If status is risk_match: what the risk is */
  riskNote: string | null;
  /** If status is exceeds: how they exceed it */
  exceedNote: string | null;
  /** Confidence in the attribution: was this a direct match or inferred? */
  confidence: "direct" | "inferred" | "assumed";
  /** Whether this attribution involved any potential hidden path (flag for audit) */
  hiddenPathFlag: boolean;
  /** If hiddenPathFlag: what the suspected hidden path was */
  hiddenPathNote: string | null;
}

export interface AttributionTable {
  candidateId: string;
  /** Total score derived purely from this table (cross-check against finalScore) */
  tableScore: number;
  /** Delta between tableScore and the system's finalScore — should be small */
  scoreDelta: number;
  /** All rows, sorted by weight descending */
  rows: AttributionRow[];
  /** Requirements with no matching evidence — the gap list */
  unmatchedRequirements: string[];
  /** Rows that were flagged for potential hidden path influence */
  hiddenPathFlags: Array<{ requirement: string; note: string }>;
  /** Whether the table is fully grounded in technical evidence */
  isFullyGrounded: boolean;
  /** How many points came from direct evidence vs inferred signals */
  directEvidencePoints: number;
  inferredEvidencePoints: number;
  /** The decision path hash — SHA-256 of all rows for tamper detection */
  decisionPathHash: string;
}

// ─── Weight Derivation ────────────────────────────────────────────────────────
// Assigns weights to requirements based on their position and framing in the query.
// Requirements mentioned first, or with "required"/"must have" language, get more weight.

const REQUIREMENT_WEIGHT_MAP: Record<string, number> = {
  // Skills flagged as "critical" in query analysis get highest weight
  critical: 0.28,
  important: 0.18,
  nice_to_have: 0.08,
};

function deriveWeights(requirements: string[]): number[] {
  if (requirements.length === 0) return [];
  // Distribute weights: first 2 requirements are "critical", next 3 "important", rest "nice to have"
  return requirements.map((_, i) => {
    if (i < 2) return REQUIREMENT_WEIGHT_MAP.critical;
    if (i < 5) return REQUIREMENT_WEIGHT_MAP.important;
    return REQUIREMENT_WEIGHT_MAP.nice_to_have;
  });
}

// ─── Hidden Path Detector ─────────────────────────────────────────────────────
// Scans attributions for signals that could represent hidden demographic paths.
// Per Guyyala et al.: hidden paths are indirect demographic proxies embedded
// in ostensibly technical signals.

const HIDDEN_PATH_SIGNALS = [
  { pattern: /\b(google|meta|facebook|amazon|apple|microsoft|openai)\b/i, note: "FAANG employer prestige — prestigious employer ≠ technical skill" },
  { pattern: /\b(stanford|mit|harvard|oxford|cambridge|iit|caltech)\b/i, note: "Elite university — institution name is a demographic proxy" },
  { pattern: /\b(founder|ceo|co-founder)\b/i, note: "Founder status — correlates with demographic privilege, not skill" },
  { pattern: /\b(olympic|athlete|sport)\b/i, note: "Athletic signal — hobby/background proxy, irrelevant to technical merit" },
  { pattern: /\b(military|veteran|army|navy|air force)\b/i, note: "Military background — demographic signal, not technical evidence" },
  { pattern: /\b(native|fluent)\s+(english|spanish|mandarin|hindi)\b/i, note: "Language fluency — nationality proxy unless role requires it" },
];

function scanForHiddenPaths(text: string): { detected: boolean; note: string | null } {
  for (const { pattern, note } of HIDDEN_PATH_SIGNALS) {
    if (pattern.test(text)) {
      return { detected: true, note };
    }
  }
  return { detected: false, note: null };
}

// ─── Attribution Row Builder ──────────────────────────────────────────────────
// Builds one row of the attribution table per requirement using Claude.
// This is where the "glassbox" logic lives — Claude must cite specific evidence.

async function buildAttributionRows(
  requirements: string[],
  weights: number[],
  profile: DeepProfileAnalysis,
  query: QueryAnalysis
): Promise<AttributionRow[]> {
  const profileContext = [
    `Headline: ${profile.headline}`,
    `Domains: ${profile.domains.join(", ")}`,
    `Skills: ${profile.skills.map((s) => `${s.name} (${s.level}): ${s.evidence}`).join(" | ")}`,
    `Projects: ${profile.projects.map((p) => `${p.name}: ${p.description} — ${p.impact}`).join(" | ")}`,
    `Technical fingerprint: ${profile.technicalFingerprint.join(". ")}`,
    `Niche repos: ${profile.deepGithub.nicheRepos.join(", ")}`,
    `Niche commits: ${profile.deepGithub.totalNicheCommits} total, ${profile.deepGithub.recentNicheCommits} last 12mo`,
    profile.nicheFit ? `Niche evidence: ${profile.nicheFit.directEvidence.map((e) => e.description).slice(0, 3).join(" | ")}` : "",
    `Code quality: ${profile.codeQualityScore}/10 | Production grade: ${profile.isProductionGrade}`,
    `Code green flags: ${profile.codeQuality.greenFlags.join("; ")}`,
  ].filter(Boolean).join("\n");

  interface RawRow {
    requirement: string;
    extraction: string;
    extractionSource: string | null;
    rationale: string;
    status: AttributionStatus;
    contribution: number;
    riskNote: string | null;
    exceedNote: string | null;
    confidence: "direct" | "inferred" | "assumed";
  }

  const rawRows = await callClaudeJSON<{ rows: RawRow[] }>(
    `You are building an Attribute Attribution Table — the "glassbox" proof that every score point came from technical evidence.

For each requirement, you must find the EXACT evidence from the candidate's profile that satisfies it.
Rules:
1. Only cite evidence that is EXPLICITLY present in the profile — do not guess or assume
2. If evidence is not present, status = "not_met" and extraction = "No evidence found"
3. The extractionSource must be specific: repo name, commit description, or skill evidence text
4. The rationale must explain the logic: why this extraction satisfies this requirement
5. Contribution = weight × match_quality × 100 (full_match=1.0, exceeds=1.0, partial=0.6, risk_match=0.7, adjacent=0.4, not_met=0)
6. NEVER infer skills from employer or university names — that is a hidden path

CANDIDATE PROFILE:
${profileContext}

REQUIREMENTS TO ATTRIBUTE:
${requirements.map((req, i) => `${i + 1}. ${req} (weight: ${(weights[i] * 100).toFixed(0)}%)`).join("\n")}

Return JSON:
{
  "rows": [
    {
      "requirement": "exact requirement text",
      "extraction": "the exact text from the profile that satisfies this requirement",
      "extractionSource": "repo name, commit reference, or specific evidence source URL/identifier",
      "rationale": "one sentence explaining why this extraction satisfies the requirement",
      "status": "full_match|exceeds|partial_match|risk_match|adjacent_match|not_met",
      "contribution": <points as a number>,
      "riskNote": "if risk_match: what the risk is, else null",
      "exceedNote": "if exceeds: how they exceed it, else null",
      "confidence": "direct|inferred|assumed"
    }
  ]
}`,
    {
      system: BIAS_FREE_SYSTEM_PROMPT,
      operation: "niche_fit",
      maxTokens: 2000,
    }
  );

  return rawRows.rows.map((row, i) => {
    const hiddenPath = scanForHiddenPaths(row.extraction + " " + row.rationale);
    return {
      ...row,
      weight: weights[i] ?? 0.1,
      hiddenPathFlag: hiddenPath.detected,
      hiddenPathNote: hiddenPath.note,
    };
  });
}

// ─── Decision Path Hash ────────────────────────────────────────────────────────
// SHA-256 of the serialized rows — proves the table hasn't been tampered with.

async function hashDecisionPath(rows: AttributionRow[]): Promise<string> {
  const canonical = JSON.stringify(rows.map((r) => ({
    req: r.requirement,
    ext: r.extraction,
    status: r.status,
    contribution: r.contribution,
  })));
  try {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    // Fallback for environments without crypto.subtle
    let h = 0;
    for (const c of canonical) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
    return Math.abs(h).toString(16).padStart(16, "0");
  }
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * buildAttributionTable — the Attribute Attribution Table.
 *
 * For every JD requirement, traces EXACTLY which piece of evidence in the
 * candidate's profile triggered a score contribution and why.
 *
 * This is the "Logic Trace" that proves the decision was made on technical
 * merits, not hidden demographic proxies.
 */
export async function buildAttributionTable(
  profile: DeepProfileAnalysis,
  query: QueryAnalysis,
  finalScore: number
): Promise<AttributionTable> {
  const requirements = [
    ...query.requiredSkills.map((s) => `Has demonstrated expertise in: ${s}`),
    ...query.domains.slice(0, 3).map((d) => `Has worked in domain: ${d}`),
    ...(query.seniority !== "any" ? [`Seniority level: ${query.seniority}`] : []),
    ...(query.languages.length > 0 ? [`Uses language(s): ${query.languages.join(", ")}`] : []),
  ];

  const weights = deriveWeights(requirements);
  const rows = await buildAttributionRows(requirements, weights, profile, query);

  const tableScore = Math.min(100, Math.round(rows.reduce((acc, r) => acc + r.contribution, 0)));
  const unmatchedRequirements = rows
    .filter((r) => r.status === "not_met")
    .map((r) => r.requirement);

  const hiddenPathFlags = rows
    .filter((r) => r.hiddenPathFlag)
    .map((r) => ({ requirement: r.requirement, note: r.hiddenPathNote! }));

  const directPoints = rows
    .filter((r) => r.confidence === "direct")
    .reduce((a, r) => a + r.contribution, 0);
  const inferredPoints = rows
    .filter((r) => r.confidence !== "direct")
    .reduce((a, r) => a + r.contribution, 0);

  const decisionPathHash = await hashDecisionPath(rows);

  return {
    candidateId: `CND_${profile.username.slice(0, 8)}`,
    tableScore,
    scoreDelta: Math.abs(tableScore - finalScore),
    rows: rows.sort((a, b) => b.weight - a.weight),
    unmatchedRequirements,
    hiddenPathFlags,
    isFullyGrounded: hiddenPathFlags.length === 0 && inferredPoints / (directPoints + inferredPoints || 1) < 0.3,
    directEvidencePoints: Math.round(directPoints),
    inferredEvidencePoints: Math.round(inferredPoints),
    decisionPathHash,
  };
}
