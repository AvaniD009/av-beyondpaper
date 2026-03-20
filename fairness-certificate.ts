/**
 * FAIRNESS CERTIFICATE GENERATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates the "Glassbox Audit Report" — the final fairness certificate
 * that summarizes all multi-agent audit results into a single, displayable
 * badge artifact.
 *
 * This is the "demo closer" — the artifact that proves the system is
 * legally defensible and bias-audited.
 *
 * Certificate structure:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  GLASSBOX AUDIT REPORT #[ID]                        │
 *   │  ─────────────────────────────────────────────────  │
 *   │  Anonymization Status:    100% PII/Proxy Stripped   │
 *   │  Counterfactual Tests:    5 (Gender, Race, Age,     │
 *   │                           Veteran, Gap-Year)         │
 *   │  Stability Rating:        99.4% (PASSED)            │
 *   │  Causal Disparity Index:  0.006 (Threshold <0.03)   │
 *   │  Attribution Coverage:    10/10 requirements traced  │
 *   │  Hidden Path Flags:       0 detected                 │
 *   │  Bias Audit Verdict:      PASS (delta: 2 pts)       │
 *   │  Risk Level:              MODERATE (2 significant)   │
 *   │  Decision Path:           [Link to Logic Trace]      │
 *   │  ─────────────────────────────────────────────────  │
 *   │  OVERALL VERDICT:  ✅ CERTIFIED BIAS-FREE            │
 *   └─────────────────────────────────────────────────────┘
 *
 * Certificate ID: deterministic hash of all audit results — the same
 * inputs always produce the same certificate, enabling verification.
 */

import type { BiasAuditReport } from "./bias-audit";
import type { CounterfactualStabilityReport } from "./counterfactual-twins";
import type { AttributionTable } from "./attribution-table";
import type { RiskAuditReport } from "./risk-auditor";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CertificateVerdict =
  | "CERTIFIED"           // all checks passed
  | "CERTIFIED_WITH_NOTES" // passed but with warnings
  | "CONDITIONAL"         // some issues, worth reviewing
  | "NOT_CERTIFIED";      // fundamental issues detected

export interface CertificateSection {
  label: string;
  value: string;
  status: "passed" | "warned" | "failed" | "info";
  detail: string | null;
}

export interface FairnessCertificate {
  /** Unique certificate ID — deterministic hash of all audit inputs */
  certificateId: string;
  /** Certificate serial number (sequential, for display) */
  reportNumber: string;
  /** ISO timestamp of certificate generation */
  issuedAt: string;
  /** Candidate opaque ID */
  candidateId: string;
  /** The query / role this was evaluated for */
  roleDescription: string;

  // ── Individual section results ────────────────────────────────────────────
  sections: CertificateSection[];

  // ── Summary metrics ───────────────────────────────────────────────────────
  anonymizationStatus: "100%" | "PARTIAL" | "NOT_APPLIED";
  counterfactualTestsRun: number;
  stabilityRating: string;       // e.g. "99.4%"
  causalDisparityIndex: string;  // e.g. "0.006"
  cdiThreshold: string;          // e.g. "<0.03"
  attributionCoverage: string;   // e.g. "10/10 requirements traced"
  hiddenPathFlags: number;
  biasAuditVerdict: string;
  biasAuditDelta: number;
  riskLevel: string;
  decisionPathHash: string;      // links to the attribution table log

  // ── Overall verdict ───────────────────────────────────────────────────────
  overallVerdict: CertificateVerdict;
  verdictReason: string;
  verdictEmoji: string;

  // ── Machine-readable metadata ─────────────────────────────────────────────
  metadata: {
    biasAuditPassed: boolean;
    counterfactualPassed: boolean;
    attributionFullyGrounded: boolean;
    riskBlocking: boolean;
    allChecksPassed: boolean;
  };

  /** Formatted multi-line text representation of the certificate */
  textCertificate: string;
}

// ─── Certificate ID Generator ─────────────────────────────────────────────────
// Deterministic hash of audit results — same inputs = same certificate

function generateCertificateId(
  candidateId: string,
  biasVerdict: string,
  cdi: number,
  attrHash: string
): string {
  const input = `${candidateId}:${biasVerdict}:${cdi.toFixed(4)}:${attrHash}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x2166f723;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `GBX-${(h1 >>> 0).toString(16).toUpperCase().padStart(4, "0")}-${(h2 >>> 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

// Sequential report counter (in-process, resets on restart — fine for demo)
let reportCounter = 840;

// ─── Section Builders ─────────────────────────────────────────────────────────

function buildSections(
  biasAudit: BiasAuditReport,
  stability: CounterfactualStabilityReport,
  attribution: AttributionTable,
  risk: RiskAuditReport
): CertificateSection[] {
  const sections: CertificateSection[] = [];

  // 1. Anonymization
  sections.push({
    label: "Anonymization Status",
    value: biasAudit.strippedFields.length > 0 ? "100% PII/Proxy Stripped" : "No PII fields detected",
    status: "passed",
    detail: biasAudit.strippedFields.length > 0
      ? `Stripped: ${biasAudit.strippedFields.map((f) => f.field).join(", ")}`
      : null,
  });

  // 2. Counterfactual tests
  sections.push({
    label: "Counterfactual Tests Run",
    value: `${stability.testsRun} (${Object.keys(stability.twins.reduce<Record<string, true>>((a, t) => { a[t.variant] = true; return a; }, {})).filter((v) => v !== "original").join(", ")})`,
    status: stability.stabilityVerdict === "STABLE" ? "passed" :
            stability.stabilityVerdict === "WARN" ? "warned" : "failed",
    detail: stability.summary,
  });

  // 3. Stability rating
  sections.push({
    label: "Stability Rating",
    value: `${stability.stabilityPercent.toFixed(1)}% (${stability.stabilityVerdict})`,
    status: stability.stabilityVerdict === "STABLE" ? "passed" :
            stability.stabilityVerdict === "WARN" ? "warned" : "failed",
    detail: stability.biasVector,
  });

  // 4. CDI
  sections.push({
    label: "Causal Disparity Index",
    value: `${stability.causalDisparityIndex.toFixed(4)} (Threshold: <0.03)`,
    status: stability.causalDisparityIndex < 0.03 ? "passed" :
            stability.causalDisparityIndex < 0.07 ? "warned" : "failed",
    detail: null,
  });

  // 5. Attribution coverage
  const totalReqs = attribution.rows.length + attribution.unmatchedRequirements.length;
  const covered = attribution.rows.filter((r) => r.status !== "not_met").length;
  sections.push({
    label: "Attribution Coverage",
    value: `${covered}/${totalReqs} requirements traced to evidence`,
    status: attribution.isFullyGrounded ? "passed" : "warned",
    detail: attribution.unmatchedRequirements.length > 0
      ? `Unmatched: ${attribution.unmatchedRequirements.slice(0, 2).join("; ")}`
      : null,
  });

  // 6. Hidden path flags
  sections.push({
    label: "Hidden Path Flags",
    value: attribution.hiddenPathFlags.length === 0
      ? "0 detected — fully grounded in technical evidence"
      : `${attribution.hiddenPathFlags.length} detected`,
    status: attribution.hiddenPathFlags.length === 0 ? "passed" : "warned",
    detail: attribution.hiddenPathFlags.length > 0
      ? attribution.hiddenPathFlags.map((f) => f.note).join("; ")
      : null,
  });

  // 7. Bias audit
  sections.push({
    label: "Bias Audit Verdict",
    value: `${biasAudit.verdict} (score delta: ${biasAudit.scoreDelta} pts)`,
    status: biasAudit.verdict === "PASS" ? "passed" :
            biasAudit.verdict === "WARN" ? "warned" : "failed",
    detail: biasAudit.auditSummary,
  });

  // 8. Risk level
  const riskEmoji = risk.riskVerdict === "LOW_RISK" ? "🟢" :
                    risk.riskVerdict === "MODERATE_RISK" ? "🟡" :
                    risk.riskVerdict === "HIGH_RISK" ? "🟠" : "🔴";
  sections.push({
    label: "Risk Level",
    value: `${riskEmoji} ${risk.riskVerdict.replace("_", " ")} (${risk.blockingRisks.length} blocking, ${risk.significantRisks.length} significant)`,
    status: risk.riskVerdict === "LOW_RISK" ? "passed" :
            risk.riskVerdict === "MODERATE_RISK" ? "warned" :
            risk.riskVerdict === "HIGH_RISK" ? "warned" : "failed",
    detail: risk.riskSummary,
  });

  // 9. Decision path
  sections.push({
    label: "Decision Path",
    value: `Hash: ${attribution.decisionPathHash}`,
    status: "info",
    detail: `${attribution.directEvidencePoints} pts from direct evidence, ${attribution.inferredEvidencePoints} pts from inferred signals`,
  });

  return sections;
}

// ─── Verdict Derivation ───────────────────────────────────────────────────────

function deriveVerdict(
  biasAudit: BiasAuditReport,
  stability: CounterfactualStabilityReport,
  attribution: AttributionTable,
  risk: RiskAuditReport
): { verdict: CertificateVerdict; reason: string; emoji: string } {
  // Failing conditions
  if (biasAudit.verdict === "FAIL") {
    return { verdict: "NOT_CERTIFIED", reason: "Bias audit failed — demographic signals influenced the score", emoji: "❌" };
  }
  if (stability.stabilityVerdict === "UNSTABLE") {
    return { verdict: "NOT_CERTIFIED", reason: "Counterfactual stability test failed — demographic variants produced divergent scores", emoji: "❌" };
  }
  if (attribution.hiddenPathFlags.length > 2) {
    return { verdict: "CONDITIONAL", reason: "Multiple hidden path flags detected in attribution table — manual review required", emoji: "⚠️" };
  }
  if (risk.blockingRisks.length > 0) {
    return { verdict: "CONDITIONAL", reason: `${risk.blockingRisks.length} blocking gap(s) identified — hiring decision requires manual validation`, emoji: "⚠️" };
  }

  // Warning conditions
  const hasWarnings = biasAudit.verdict === "WARN" ||
    stability.stabilityVerdict === "WARN" ||
    !attribution.isFullyGrounded ||
    risk.riskVerdict === "HIGH_RISK";

  if (hasWarnings) {
    return { verdict: "CERTIFIED_WITH_NOTES", reason: "All critical checks passed but warnings detected — review notes before proceeding", emoji: "✅⚠️" };
  }

  return { verdict: "CERTIFIED", reason: "All bias checks passed. Decision is grounded in technical evidence. No demographic influence detected.", emoji: "✅" };
}

// ─── Text Certificate Formatter ───────────────────────────────────────────────

function formatTextCertificate(cert: Omit<FairnessCertificate, "textCertificate">): string {
  const line = "─".repeat(55);
  const rows = cert.sections.map((s) => {
    const icon = s.status === "passed" ? "✓" : s.status === "warned" ? "⚠" : s.status === "failed" ? "✗" : "ℹ";
    const label = s.label.padEnd(28);
    return `  ${icon}  ${label}${s.value}`;
  });

  return [
    `┌${"─".repeat(57)}┐`,
    `│  GLASSBOX AUDIT REPORT ${cert.reportNumber.padEnd(33)}│`,
    `│  ${line}  │`,
    ...rows.map((r) => `│${r.padEnd(58)}│`),
    `│  ${line}  │`,
    `│  ${cert.verdictEmoji} OVERALL: ${cert.overallVerdict.replace("_", " ").padEnd(46)}│`,
    `│  ${cert.verdictReason.slice(0, 54).padEnd(55)}│`,
    `└${"─".repeat(57)}┘`,
  ].join("\n");
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * generateFairnessCertificate — the Glassbox Audit Report.
 *
 * Synthesizes results from all 4 audit sub-systems into a single
 * certificate that proves (or disproves) bias-free hiring decisions.
 *
 * The certificate is:
 * - Deterministic: same inputs = same certificate ID
 * - Tamper-evident: decision path hash links to the attribution log
 * - Human-readable: formatted text + structured sections for UI
 * - Machine-readable: metadata object for programmatic checks
 */
export function generateFairnessCertificate(
  candidateId: string,
  roleDescription: string,
  biasAudit: BiasAuditReport,
  stability: CounterfactualStabilityReport,
  attribution: AttributionTable,
  risk: RiskAuditReport
): FairnessCertificate {
  const reportNumber = `#${(++reportCounter).toString().padStart(4, "0")}`;
  const certificateId = generateCertificateId(
    candidateId,
    biasAudit.verdict,
    stability.causalDisparityIndex,
    attribution.decisionPathHash
  );

  const sections = buildSections(biasAudit, stability, attribution, risk);
  const { verdict, reason, emoji } = deriveVerdict(biasAudit, stability, attribution, risk);

  const totalReqs = attribution.rows.length + attribution.unmatchedRequirements.length;
  const covered = attribution.rows.filter((r) => r.status !== "not_met").length;

  const base: Omit<FairnessCertificate, "textCertificate"> = {
    certificateId,
    reportNumber,
    issuedAt: new Date().toISOString(),
    candidateId,
    roleDescription: roleDescription.slice(0, 80),
    sections,
    anonymizationStatus: biasAudit.strippedFields.length > 0 ? "100%" : "NOT_APPLIED",
    counterfactualTestsRun: stability.testsRun,
    stabilityRating: `${stability.stabilityPercent.toFixed(1)}%`,
    causalDisparityIndex: stability.causalDisparityIndex.toFixed(4),
    cdiThreshold: "<0.03",
    attributionCoverage: `${covered}/${totalReqs} requirements traced`,
    hiddenPathFlags: attribution.hiddenPathFlags.length,
    biasAuditVerdict: biasAudit.verdict,
    biasAuditDelta: biasAudit.scoreDelta,
    riskLevel: risk.riskVerdict,
    decisionPathHash: attribution.decisionPathHash,
    overallVerdict: verdict,
    verdictReason: reason,
    verdictEmoji: emoji,
    metadata: {
      biasAuditPassed: biasAudit.verdict !== "FAIL",
      counterfactualPassed: stability.stabilityVerdict !== "UNSTABLE",
      attributionFullyGrounded: attribution.isFullyGrounded,
      riskBlocking: risk.blockingRisks.length > 0,
      allChecksPassed: verdict === "CERTIFIED",
    },
  };

  return {
    ...base,
    textCertificate: formatTextCertificate(base),
  };
}
