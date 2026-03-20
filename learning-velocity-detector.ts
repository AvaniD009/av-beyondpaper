/**
 * LEARNING VELOCITY DETECTOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Measures how fast this specific engineer acquires new skills.
 *
 * This is the most important predictor of future learning speed.
 * Past learning velocity is the best proxy for future learning velocity.
 *
 * Measurement methodology:
 *
 *   For each skill in the timeline that was "acquired" (has a substantive repo):
 *     - firstContactDate: when they touched it first
 *     - proficiencyDate: when they produced a real project in it
 *     - velocityDays: proficiencyDate - firstContactDate
 *
 *   LearningVelocity = median(velocityDays across all acquired skills)
 *   (Median used to resist outliers: one very fast or very slow acquisition
 *    shouldn't dominate the estimate.)
 *
 * Velocity coefficient:
 *   < 30 days  → "rapid" (0.4× modifier — fast learner discount)
 *   30–90 days → "fast"  (0.7×)
 *   90–180 days→ "average" (1.0×)
 *   180–365 days→ "methodical" (1.4×)
 *   > 365 days → "deliberate" (1.8×)
 *
 * Additional signals:
 *
 *   COMPLEXITY RAMP RATE — how quickly do their repos in a new skill
 *   go from simple to complex? Fast ramp = deep engagement, not just dabbling.
 *
 *   ADJACENT SKILL BONUS — when they already had an adjacent skill,
 *   did they learn faster? This validates the skill graph's transfer estimates.
 *
 *   PARADIGM SHIFT HISTORY — have they successfully crossed a paradigm
 *   boundary before? (e.g. learned a functional language after OOP background)
 *   If yes, they've proven they can rewire their mental model.
 *
 *   SELF-DIRECTED vs FORCED — solo learning projects vs work-assigned skills
 *   (approximated from: experimental repos vs forks of company projects)
 */

import type { LearningTrajectory, SkillTimelineEntry } from "./skill-trajectory-mapper";
import { getSkillNode, getDirectEdge } from "./skill-graph";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VelocityTier = "rapid" | "fast" | "average" | "methodical" | "deliberate";

export interface SkillAcquisitionRecord {
  skillId: string;
  velocityDays: number;
  hadAdjacentSkill: boolean;        // did they already have an adjacent skill?
  adjacentSkillBonus: number;       // how many days faster than without adjacency (estimated)
  complexityRampRate: number;       // 1–10: how fast did complexity grow?
  wasSelfDirected: boolean;
  outcomeQuality: "production" | "substantive" | "experimental";
}

export interface LearningVelocityProfile {
  /** Median days to go from first contact → substantive project */
  medianVelocityDays: number;
  /** Velocity classification */
  velocityTier: VelocityTier;
  /** Modifier to apply to TTP estimates (lower = faster learner) */
  velocityCoefficient: number;
  /** All individual acquisition records that fed this estimate */
  acquisitionRecords: SkillAcquisitionRecord[];
  /** Whether they've successfully crossed a paradigm boundary before */
  provenParadigmShifter: boolean;
  /** Details of their strongest paradigm shift (most impressive transition) */
  strongestParadigmShift: {
    from: string; to: string; daysToProf: number; wasHardTransition: boolean;
  } | null;
  /** Accelerating vs decelerating: are they learning faster or slower recently? */
  recentTrend: "accelerating" | "stable" | "decelerating" | "insufficient_data";
  /** Skills they seem to acquire unusually fast (natural affinity domains) */
  fastDomains: string[];
  /** Skills/domains they took longer on (evidence of harder transitions) */
  slowDomains: string[];
  /** Confidence in this velocity estimate */
  confidence: "high" | "medium" | "low";
  /** How many acquisitions were available to compute from */
  sampleSize: number;
}

// ─── Velocity Constants ───────────────────────────────────────────────────────

const VELOCITY_TIERS: Array<{ maxDays: number; tier: VelocityTier; coefficient: number }> = [
  { maxDays: 30,  tier: "rapid",       coefficient: 0.4 },
  { maxDays: 90,  tier: "fast",        coefficient: 0.7 },
  { maxDays: 180, tier: "average",     coefficient: 1.0 },
  { maxDays: 365, tier: "methodical",  coefficient: 1.4 },
  { maxDays: Infinity, tier: "deliberate", coefficient: 1.8 },
];

function classifyVelocity(medianDays: number): { tier: VelocityTier; coefficient: number } {
  for (const t of VELOCITY_TIERS) {
    if (medianDays <= t.maxDays) return { tier: t.tier, coefficient: t.coefficient };
  }
  return { tier: "deliberate", coefficient: 1.8 };
}

// ─── Acquisition Record Builder ───────────────────────────────────────────────

function buildAcquisitionRecord(
  entry: SkillTimelineEntry,
  trajectory: LearningTrajectory
): SkillAcquisitionRecord | null {
  // Need proficiency date to measure velocity
  if (!entry.proficiencyDate) return null;

  const velocityDays = Math.max(1, Math.round(
    (new Date(entry.proficiencyDate).getTime() - new Date(entry.firstSeenDate).getTime()) /
    (1000 * 60 * 60 * 24)
  ));

  // Did they have an adjacent skill when they started this one?
  const prereqs = entry.prerequisiteContext;
  const node = getSkillNode(entry.skillId);
  const adjacentPrereqs = prereqs.filter((p) => {
    const edge = getDirectEdge(p, entry.skillId);
    return edge && edge.transferPotential > 0.6;
  });

  const hadAdjacentSkill = adjacentPrereqs.length > 0;

  // Estimate how much faster the adjacent skill made them
  // (approximated: if transfer potential = 0.7, saved roughly 30% of time)
  const avgTransfer = hadAdjacentSkill
    ? adjacentPrereqs.reduce((a, p) => {
        const edge = getDirectEdge(p, entry.skillId);
        return a + (edge?.transferPotential ?? 0);
      }, 0) / adjacentPrereqs.length
    : 0;
  const adjacentSkillBonus = hadAdjacentSkill ? Math.round(velocityDays * avgTransfer * 0.5) : 0;

  return {
    skillId: entry.skillId,
    velocityDays,
    hadAdjacentSkill,
    adjacentSkillBonus,
    complexityRampRate: Math.max(1, entry.complexitySlope + 5), // normalize slope to 1–10
    wasSelfDirected: entry.acquisitionMode === "solo_project" || entry.acquisitionMode === "both",
    outcomeQuality: entry.complexitySlope > 3 ? "production" :
                    entry.proficiencyDate ? "substantive" : "experimental",
  };
}

// ─── Trend Analyzer ───────────────────────────────────────────────────────────
// Compares velocity of recent acquisitions vs older ones.

function analyzeRecentTrend(records: SkillAcquisitionRecord[]): LearningVelocityProfile["recentTrend"] {
  if (records.length < 3) return "insufficient_data";

  const half = Math.floor(records.length / 2);
  const older = records.slice(0, half);
  const recent = records.slice(-half);

  const avgOlder = older.reduce((a, r) => a + r.velocityDays, 0) / older.length;
  const avgRecent = recent.reduce((a, r) => a + r.velocityDays, 0) / recent.length;

  const ratio = avgRecent / avgOlder;
  if (ratio < 0.7) return "accelerating";   // learning faster recently
  if (ratio > 1.4) return "decelerating";   // learning slower recently
  return "stable";
}

// ─── Paradigm Shift Detector ──────────────────────────────────────────────────

function detectParadigmShifts(trajectory: LearningTrajectory): {
  provenShifter: boolean;
  strongest: LearningVelocityProfile["strongestParadigmShift"];
} {
  if (trajectory.keyTransitions.length === 0) {
    return { provenShifter: false, strongest: null };
  }

  // A paradigm shift is a transition with LOW transfer potential but GOOD outcome
  const shifts = trajectory.keyTransitions.filter(
    (t) => t.estimatedTransfer < 0.6 && t.outcomeQuality !== "unclear"
  );

  if (shifts.length === 0) return { provenShifter: false, strongest: null };

  // Most impressive = lowest transfer potential with real project outcome
  const hardest = shifts.sort(
    (a, b) => a.estimatedTransfer - b.estimatedTransfer
  )[0];

  return {
    provenShifter: true,
    strongest: {
      from: hardest.fromSkill,
      to: hardest.toSkill,
      daysToProf: hardest.monthsTaken * 30,
      wasHardTransition: hardest.estimatedTransfer < 0.5,
    },
  };
}

// ─── Domain Speed Analyzer ────────────────────────────────────────────────────

function analyzeDomainSpeeds(records: SkillAcquisitionRecord[]): {
  fastDomains: string[];
  slowDomains: string[];
} {
  const domainVelocities = new Map<string, number[]>();

  for (const record of records) {
    const node = getSkillNode(record.skillId);
    if (!node) continue;
    if (!domainVelocities.has(node.domain)) domainVelocities.set(node.domain, []);
    domainVelocities.get(node.domain)!.push(record.velocityDays);
  }

  const avgVelocity = records.length > 0
    ? records.reduce((a, r) => a + r.velocityDays, 0) / records.length
    : 90;

  const fast: string[] = [];
  const slow: string[] = [];

  for (const [domain, velocities] of domainVelocities) {
    const avg = velocities.reduce((a, v) => a + v, 0) / velocities.length;
    if (avg < avgVelocity * 0.6) fast.push(domain);
    if (avg > avgVelocity * 1.5) slow.push(domain);
  }

  return { fastDomains: fast, slowDomains: slow };
}

// ─── Median ───────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 90; // default: average developer
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * detectLearningVelocity — measures this engineer's historical learning speed.
 *
 * Uses the timeline of skill acquisitions to compute:
 *   - How long they typically take to go from first contact to real project
 *   - Whether they're getting faster or slower over time
 *   - Whether they've proven they can cross paradigm boundaries
 *   - Which domains they learn fastest in
 *
 * The velocity coefficient is the key output: it's used by the TTP estimator
 * to adjust the base skill-distance estimates.
 */
export function detectLearningVelocity(trajectory: LearningTrajectory): LearningVelocityProfile {
  // Build acquisition records from timeline entries
  const records: SkillAcquisitionRecord[] = [];
  for (const entry of trajectory.timeline) {
    const record = buildAcquisitionRecord(entry, trajectory);
    if (record) records.push(record);
  }

  const sampleSize = records.length;

  if (sampleSize === 0) {
    // No data — return conservative default
    return {
      medianVelocityDays: 90,
      velocityTier: "average",
      velocityCoefficient: 1.0,
      acquisitionRecords: [],
      provenParadigmShifter: false,
      strongestParadigmShift: null,
      recentTrend: "insufficient_data",
      fastDomains: [],
      slowDomains: [],
      confidence: "low",
      sampleSize: 0,
    };
  }

  const velocityDays = records.map((r) => r.velocityDays);
  const medianDays = median(velocityDays);
  const { tier, coefficient } = classifyVelocity(medianDays);

  const { provenShifter, strongest } = detectParadigmShifts(trajectory);
  const { fastDomains, slowDomains } = analyzeDomainSpeeds(records);
  const recentTrend = analyzeRecentTrend(records);

  // Confidence: based on how many data points we have
  const confidence: LearningVelocityProfile["confidence"] =
    sampleSize >= 5 ? "high" : sampleSize >= 2 ? "medium" : "low";

  return {
    medianVelocityDays: Math.round(medianDays),
    velocityTier: tier,
    velocityCoefficient: coefficient,
    acquisitionRecords: records,
    provenParadigmShifter: provenShifter,
    strongestParadigmShift: strongest,
    recentTrend,
    fastDomains,
    slowDomains,
    confidence,
    sampleSize,
  };
}
