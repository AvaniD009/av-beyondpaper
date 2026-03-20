/**
 * TIME-TO-PRODUCTIVITY ESTIMATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Estimates how long it would take THIS specific engineer to become
 * productive in a required skill they don't currently have.
 *
 * Formula:
 *
 *   TTP = base_weeks(skill_distance)
 *       × velocity_coefficient
 *       × depth_modifier
 *       × overlap_modifier
 *       × recency_modifier
 *
 * Where:
 *
 *   base_weeks(distance):
 *     distance < 1.0 → 1 week  (trivial: same syntax family)
 *     distance 1–2   → 2 weeks (easy: same paradigm, different API)
 *     distance 2–3   → 4 weeks (moderate: different mental model)
 *     distance 3–4   → 8 weeks (hard: different paradigm or domain)
 *     distance 4–5   → 16 weeks (very hard)
 *     distance > 5   → 24+ weeks (major transition)
 *
 *   velocity_coefficient:
 *     Derived from LearningVelocityProfile.velocityCoefficient.
 *     Fast learner (0.4×) to deliberate (1.8×).
 *
 *   depth_modifier:
 *     What proficiency level is required?
 *     familiarity (1×) → proficient (2×) → expert (4×)
 *
 *   overlap_modifier:
 *     How many of the candidate's existing skills transfer?
 *     High transfer (>70%) → 0.6× | Medium (40–70%) → 0.85× | Low (<40%) → 1.0×
 *
 *   recency_modifier:
 *     Did they JUST learn something adjacent (in last 6 months)?
 *     Active recent learner → 0.8× (momentum bonus)
 *     No recent learning → 1.2× (momentum tax)
 *
 * Output is a confidence-banded estimate, not a single number:
 *   optimistic: TTP × 0.6 (if everything goes well)
 *   likely: TTP (central estimate)
 *   conservative: TTP × 1.6 (if they hit friction)
 */

import {
  findBestPathFromSet,
  computeDomainOverlap,
  resolveSkillId,
  type SkillPath,
} from "./skill-graph";
import type { LearningVelocityProfile } from "./learning-velocity-detector";
import type { LearningTrajectory } from "./skill-trajectory-mapper";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DepthRequired = "familiarity" | "proficient" | "expert";
export type TTPCategory = "days" | "weeks_1_2" | "weeks_4_8" | "months_3_6" | "months_6_plus" | "year_plus";

export interface SkillGapEstimate {
  requiredSkill: string;
  /** Whether this skill has been acquired */
  alreadyHas: boolean;
  /** If already has: what level */
  currentLevel: "expert" | "proficient" | "familiar" | null;

  // ── Path ──────────────────────────────────────────────────────────────────
  /** Best path from their existing skills to this one */
  bestPath: SkillPath | null;
  /** The specific skill in their arsenal that gets them closest */
  bridgeSkill: string | null;
  /** Total distance to traverse */
  skillDistance: number;

  // ── TTP Estimate ─────────────────────────────────────────────────────────
  /** Depth level required for this role */
  depthRequired: DepthRequired;
  /** Central estimate in weeks */
  estimatedWeeks: number;
  /** Optimistic estimate (things go smoothly) */
  optimisticWeeks: number;
  /** Conservative estimate (friction and stumbling blocks) */
  conservativeWeeks: number;
  /** Human-readable time category */
  ttpCategory: TTPCategory;
  /** Plain-English estimate string: "2–4 weeks" */
  ttpDisplay: string;

  // ── Reasoning ─────────────────────────────────────────────────────────────
  /** Step-by-step calculation */
  calculationSteps: string[];
  /** What makes this faster/slower than baseline */
  modifiers: Array<{ name: string; factor: number; reason: string }>;
  /** Key insight: what specifically will make this hard or easy */
  keyInsight: string;
  /** What they should learn first on the path */
  firstStep: string | null;
  /** What will transfer from their existing knowledge */
  whatTransfers: string[];
  /** What they'll need to learn from scratch */
  whatIsNew: string[];

  // ── Confidence ────────────────────────────────────────────────────────────
  confidence: "high" | "medium" | "low";
}

export interface TimeToProductivityReport {
  candidateId: string;
  /** All required skills with gap estimates */
  gapEstimates: SkillGapEstimate[];
  /** Skills the candidate already has */
  skillsPresent: string[];
  /** Skills they're missing */
  skillsMissing: string[];
  /** Skills in adjacent territory (partial match) */
  skillsAdjacent: string[];

  /** Total estimated weeks to productivity for ALL missing skills */
  totalWeeksToFullProductivity: number;
  /** Display: "3–5 months to full productivity" */
  totalTTPDisplay: string;

  /** Whether they could be productive immediately on some requirements */
  canContributeImmediately: boolean;
  /** What they can contribute to right now */
  immediateContributionAreas: string[];

  /** Potential score (0–100): how close are they to the full skill set? */
  potentialScore: number;
  /** Potential tier */
  potentialTier: "ready_now" | "near_ready" | "strong_potential" | "longer_runway" | "major_transition";

  /** The key argument for why this candidate has high potential */
  potentialNarrative: string;
}

// ─── Base Week Calculator ─────────────────────────────────────────────────────

function baseWeeks(distance: number): number {
  if (distance < 1.0) return 1;
  if (distance < 2.0) return 2;
  if (distance < 3.0) return 4;
  if (distance < 4.0) return 8;
  if (distance < 5.0) return 16;
  return 24;
}

// ─── TTP Categorizer ─────────────────────────────────────────────────────────

function categorize(weeks: number): TTPCategory {
  if (weeks < 1) return "days";
  if (weeks <= 2) return "weeks_1_2";
  if (weeks <= 8) return "weeks_4_8";
  if (weeks <= 24) return "months_3_6";
  if (weeks <= 52) return "months_6_plus";
  return "year_plus";
}

function displayTTP(optimistic: number, conservative: number): string {
  const format = (w: number): string => {
    if (w < 1) return "a few days";
    if (w <= 2) return `${Math.round(w)}-2 weeks`;
    if (w <= 4) return "2-4 weeks";
    if (w <= 8) return "4-8 weeks";
    if (w <= 12) return "2-3 months";
    if (w <= 24) return "3-6 months";
    if (w <= 52) return "6-12 months";
    return "12+ months";
  };

  const opt = format(optimistic);
  const cons = format(conservative);

  if (opt === cons) return opt;
  return `${opt} to ${cons}`;
}

// ─── Gap Estimator per Skill ──────────────────────────────────────────────────

function estimateSkillGap(
  requiredSkill: string,
  candidateSkills: string[],
  velocity: LearningVelocityProfile,
  trajectory: LearningTrajectory,
  depthRequired: DepthRequired
): SkillGapEstimate {
  const targetId = resolveSkillId(requiredSkill) ?? requiredSkill;

  // Check if they already have it
  const alreadyHas = candidateSkills.some((s) => (resolveSkillId(s) ?? s) === targetId);
  if (alreadyHas) {
    return {
      requiredSkill, alreadyHas: true, currentLevel: "proficient",
      bestPath: null, bridgeSkill: null, skillDistance: 0,
      depthRequired, estimatedWeeks: 0, optimisticWeeks: 0, conservativeWeeks: 0,
      ttpCategory: "days", ttpDisplay: "Already has this skill",
      calculationSteps: ["Skill present in profile"], modifiers: [],
      keyInsight: "Direct match — no gap to close",
      firstStep: null, whatTransfers: ["Everything"], whatIsNew: [],
      confidence: "high",
    };
  }

  // Find best path from their skills to required skill
  const resolvedCandidateSkills = candidateSkills.map((s) => resolveSkillId(s) ?? s);
  const pathResult = findBestPathFromSet(resolvedCandidateSkills, targetId);

  const skillDistance = pathResult?.path.totalDistance ?? 5.5; // 5.5 = "no known path"
  const bridgeSkill = pathResult?.sourceSkill ?? null;
  const bestPath = pathResult?.path ?? null;

  // Base estimate
  const base = baseWeeks(skillDistance);

  // Modifiers
  const modifiers: SkillGapEstimate["modifiers"] = [];

  // 1. Velocity coefficient (from learning history)
  modifiers.push({
    name: "personal_learning_velocity",
    factor: velocity.velocityCoefficient,
    reason: `${velocity.velocityTier} learner (median ${velocity.medianVelocityDays} days to proficiency historically)`,
  });

  // 2. Depth modifier
  const depthFactor = { familiarity: 0.6, proficient: 1.0, expert: 2.2 }[depthRequired];
  modifiers.push({
    name: "depth_required",
    factor: depthFactor,
    reason: `Role requires ${depthRequired} level (not just surface familiarity)`,
  });

  // 3. Domain overlap modifier
  const domainOverlap = computeDomainOverlap(resolvedCandidateSkills, [targetId]);
  const overlapFactor = domainOverlap > 0.7 ? 0.6 : domainOverlap > 0.4 ? 0.85 : 1.0;
  if (overlapFactor < 1.0) {
    modifiers.push({
      name: "domain_overlap",
      factor: overlapFactor,
      reason: `${Math.round(domainOverlap * 100)}% domain overlap with existing skills — reduces ramp-up`,
    });
  }

  // 4. Recency modifier (active learner bonus)
  const activeSkills = trajectory.activeSkills.length;
  const recentLearner = trajectory.trajectoryDirection === "accelerating" || activeSkills > 3;
  if (recentLearner) {
    modifiers.push({
      name: "active_learner_momentum",
      factor: 0.8,
      reason: "Currently actively learning — momentum reduces ramp-up time",
    });
  }

  // 5. Paradigm shift bonus (proven they can do hard transitions)
  if (velocity.provenParadigmShifter && skillDistance > 3.0) {
    modifiers.push({
      name: "proven_paradigm_shifter",
      factor: 0.75,
      reason: "Has successfully crossed paradigm boundaries before — proven adaptability",
    });
  }

  // Compute final TTP
  const totalFactor = modifiers.reduce((a, m) => a * m.factor, 1.0);
  const estimatedWeeks = Math.max(0.5, base * totalFactor);
  const optimisticWeeks = estimatedWeeks * 0.6;
  const conservativeWeeks = estimatedWeeks * 1.6;

  // What transfers
  const edge = bestPath && bestPath.path.length >= 2
    ? { whatTransfers: (bestPath.path.length === 2 ? [] : []), whatDoesnt: [] }
    : null;
  const pathEdge = pathResult?.path.isDirect
    ? { whatTransfers: [] as string[], whatDoesnt: [] as string[] }
    : { whatTransfers: [] as string[], whatDoesnt: [] as string[] };

  // Calculation narrative
  const calculationSteps = [
    `Skill distance from "${bridgeSkill ?? "current skills"}" to "${requiredSkill}": ${skillDistance.toFixed(1)}`,
    `Base estimate: ${base} weeks`,
    ...modifiers.map((m) => `× ${m.factor.toFixed(2)} [${m.name}]: ${m.reason}`),
    `= ${estimatedWeeks.toFixed(1)} weeks (${displayTTP(optimisticWeeks, conservativeWeeks)})`,
  ];

  // Key insight
  const keyInsight = skillDistance < 2
    ? `Very close skill — ${bridgeSkill ?? "existing knowledge"} provides strong foundation. Mainly API/syntax learning.`
    : skillDistance < 3.5
    ? `Moderate transition — mental model shift needed but domain overlap helps. ${bridgeSkill ?? "Existing skills"} provide ~${Math.round((bestPath?.overallTransferPotential ?? 0.5) * 100)}% of needed foundation.`
    : `Hard transition — paradigm difference means near-full relearn of approach. Proven adaptability is the key signal here.`;

  const firstStep = bestPath && bestPath.path.length > 2
    ? `First learn: ${bestPath.path[1]} (intermediate stepping stone)`
    : bridgeSkill
    ? `Build on: ${bridgeSkill} (${Math.round((bestPath?.overallTransferPotential ?? 0.5) * 100)}% transfers)`
    : `No adjacent foundation — start from: ${requiredSkill} basics`;

  return {
    requiredSkill,
    alreadyHas: false,
    currentLevel: null,
    bestPath,
    bridgeSkill,
    skillDistance,
    depthRequired,
    estimatedWeeks: Math.round(estimatedWeeks * 2) / 2,
    optimisticWeeks: Math.round(optimisticWeeks * 2) / 2,
    conservativeWeeks: Math.round(conservativeWeeks * 2) / 2,
    ttpCategory: categorize(estimatedWeeks),
    ttpDisplay: displayTTP(optimisticWeeks, conservativeWeeks),
    calculationSteps,
    modifiers,
    keyInsight,
    firstStep,
    whatTransfers: pathResult?.path.isDirect ? [] : [],
    whatIsNew: [],
    confidence: velocity.confidence,
  };
}

// ─── Potential Score ─────────────────────────────────────────────────────────

function computePotentialScore(gaps: SkillGapEstimate[]): number {
  if (gaps.length === 0) return 100;

  const totalSkills = gaps.length;
  const present = gaps.filter((g) => g.alreadyHas).length;
  const nearReady = gaps.filter((g) => !g.alreadyHas && g.estimatedWeeks <= 4).length;
  const shortRunway = gaps.filter((g) => !g.alreadyHas && g.estimatedWeeks <= 12).length;

  // Weighted: present skills count more, near-ready count partially
  const weightedScore =
    (present * 3 + nearReady * 2 + shortRunway * 1) /
    (totalSkills * 3);

  return Math.min(100, Math.round(weightedScore * 100));
}

function potentialTier(
  score: number,
  totalMissingWeeks: number
): TimeToProductivityReport["potentialTier"] {
  if (score >= 90 || totalMissingWeeks <= 2) return "ready_now";
  if (score >= 75 || totalMissingWeeks <= 8) return "near_ready";
  if (score >= 55 || totalMissingWeeks <= 20) return "strong_potential";
  if (score >= 35 || totalMissingWeeks <= 52) return "longer_runway";
  return "major_transition";
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * estimateTimeToProductivity — computes TTP for each missing required skill.
 *
 * This is the output that directly answers the hackathon requirement:
 * "Rank candidates not just by current skills but by skill-distance to
 *  required skills. Output a Time-to-Productivity estimate with reasoning."
 */
export function estimateTimeToProductivity(
  candidateId: string,
  candidateSkills: string[],
  requiredSkills: string[],
  velocity: LearningVelocityProfile,
  trajectory: LearningTrajectory,
  depthRequired: DepthRequired = "proficient"
): TimeToProductivityReport {
  const gaps = requiredSkills.map((skill) =>
    estimateSkillGap(skill, candidateSkills, velocity, trajectory, depthRequired)
  );

  const present = gaps.filter((g) => g.alreadyHas).map((g) => g.requiredSkill);
  const missing = gaps.filter((g) => !g.alreadyHas && g.skillDistance > 2.5).map((g) => g.requiredSkill);
  const adjacent = gaps.filter((g) => !g.alreadyHas && g.skillDistance <= 2.5).map((g) => g.requiredSkill);

  // Total weeks = sum of all missing skills (assume sequential learning for conservatism)
  const totalWeeks = gaps
    .filter((g) => !g.alreadyHas)
    .reduce((a, g) => a + g.estimatedWeeks, 0);

  const canContribute = present.length > 0 || adjacent.length > 0;
  const immediateAreas = [...present, ...adjacent];

  const potentialScore = computePotentialScore(gaps);
  const tier = potentialTier(potentialScore, totalWeeks);

  // TTP display
  const optimisticTotal = gaps.filter((g) => !g.alreadyHas).reduce((a, g) => a + g.optimisticWeeks, 0);
  const conservativeTotal = gaps.filter((g) => !g.alreadyHas).reduce((a, g) => a + g.conservativeWeeks, 0);
  const totalTTPDisplay = missing.length === 0 && adjacent.length === 0
    ? "Ready now — has all required skills"
    : `Full productivity in ${displayTTP(optimisticTotal, conservativeTotal)}`;

  // Potential narrative
  const velocityAdjective = {
    rapid: "rapidly", fast: "quickly", average: "steadily",
    methodical: "methodically", deliberate: "deliberately",
  }[velocity.velocityTier];

  const nearestGap = [...gaps]
    .filter((g) => !g.alreadyHas)
    .sort((a, b) => a.estimatedWeeks - b.estimatedWeeks)[0];

  const potentialNarrative = [
    tier === "ready_now" ? "Has all required skills — can contribute from day one." :
    tier === "near_ready" ? `Near-ready candidate. ${adjacent.length} required skills are adjacent to what they already know.` :
    `Strong potential candidate. Currently has ${present.length}/${requiredSkills.length} required skills.`,

    velocity.velocityTier !== "average" && velocity.sampleSize > 0
      ? `Historically learns new skills ${velocityAdjective} (median ${velocity.medianVelocityDays} days to proficiency).`
      : "",

    velocity.provenParadigmShifter && velocity.strongestParadigmShift
      ? `Has proven ability to cross paradigm boundaries: transitioned from ${velocity.strongestParadigmShift.from} to ${velocity.strongestParadigmShift.to} in ${Math.round(velocity.strongestParadigmShift.daysToProf / 30)} months.`
      : "",

    nearestGap
      ? `Nearest gap: ${nearestGap.requiredSkill} (${nearestGap.ttpDisplay} via ${nearestGap.bridgeSkill ?? "existing knowledge"}).`
      : "",
  ].filter(Boolean).join(" ");

  return {
    candidateId,
    gapEstimates: gaps,
    skillsPresent: present,
    skillsMissing: missing,
    skillsAdjacent: adjacent,
    totalWeeksToFullProductivity: Math.round(totalWeeks * 2) / 2,
    totalTTPDisplay,
    canContributeImmediately: canContribute,
    immediateContributionAreas: immediateAreas,
    potentialScore,
    potentialTier: tier,
    potentialNarrative,
  };
}

// Re-export display helper for UI use
export { displayTTP };
