/**
 * POTENTIAL SCORER — LEARNING TRAJECTORY ORCHESTRATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates all learning-trajectory sub-agents and produces the final
 * PotentialProfile that gets merged into Agent 4's ranking.
 *
 * Pipeline:
 *   1. buildSkillTimeline(repos)         → LearningTrajectory
 *   2. detectLearningVelocity(timeline)  → LearningVelocityProfile
 *   3. estimateTimeToProductivity(...)   → TimeToProductivityReport
 *   4. synthesizePotentialProfile(all)   → PotentialProfile
 *
 * The PotentialProfile is what gets attached to every RankedResult.
 * It contains everything needed to rank candidates by POTENTIAL, not just
 * current state.
 *
 * Scoring model for potential dimension (D9 in final ranking):
 *
 *   potential_score = 0.35 × ttp_score        (inverse of time-to-productivity)
 *                   + 0.30 × velocity_score    (how fast they learn)
 *                   + 0.20 × trajectory_score  (are they accelerating?)
 *                   + 0.15 × adjacency_score   (how close existing skills are)
 *
 * This score is added as a new dimension (D9: "Learning Potential") to the
 * existing 8 dimensions in ranking.ts, with weight 0.12.
 */

import type { GitHubRepo } from "@/lib/github/client";
import { buildSkillTimeline, type LearningTrajectory } from "./skill-trajectory-mapper";
import { detectLearningVelocity, type LearningVelocityProfile } from "./learning-velocity-detector";
import {
  estimateTimeToProductivity,
  type TimeToProductivityReport,
  type DepthRequired,
} from "./time-to-productivity";
import { computeDomainOverlap, resolveSkillId } from "./skill-graph";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PotentialProfile {
  candidateId: string;
  username: string;

  // ── Core assessments ──────────────────────────────────────────────────────
  trajectory: LearningTrajectory;
  velocity: LearningVelocityProfile;
  ttp: TimeToProductivityReport;

  // ── Composite potential score (0–100) ─────────────────────────────────────
  potentialScore: number;

  // ── Dimension breakdown ───────────────────────────────────────────────────
  ttpdScore: number;        // time-to-productivity dimension score (0–100)
  velocityScore: number;    // learning velocity dimension score (0–100)
  trajectoryScore: number;  // trajectory direction/momentum (0–100)
  adjacencyScore: number;   // proximity of existing skills to required (0–100)

  // ── Ranking dimension for Agent 4 ────────────────────────────────────────
  /** Used as D9 in the 8-dimension ranking model */
  rankingDimensionScore: number;
  rankingDimensionLabel: string;
  rankingDimensionEvidence: string;

  // ── Human-readable outputs ────────────────────────────────────────────────
  /** The key insight about their potential — 1 sentence */
  potentialHeadline: string;

  /** Full reasoning: why they're ranked by potential this way */
  potentialReasoning: string[];

  /** What specifically makes them a "learn into the role" candidate */
  learnerSignals: string[];

  /** Risk factors in the learning trajectory */
  learnerRisks: string[];

  /** Recommendation: hire for current skills, potential, or hybrid */
  hiringMode: "current_skills" | "potential_play" | "hybrid";
  hiringModeRationale: string;
}

// ─── Sub-score Calculators ────────────────────────────────────────────────────

function computeTTPScore(ttp: TimeToProductivityReport): number {
  // Invert: shorter TTP → higher score
  const totalWeeks = ttp.totalWeeksToFullProductivity;
  if (totalWeeks === 0) return 100; // has everything
  if (totalWeeks <= 2) return 90;
  if (totalWeeks <= 4) return 80;
  if (totalWeeks <= 8) return 70;
  if (totalWeeks <= 16) return 55;
  if (totalWeeks <= 26) return 40;
  if (totalWeeks <= 52) return 25;
  return 10;
}

function computeVelocityScore(velocity: LearningVelocityProfile): number {
  const tierScores: Record<string, number> = {
    rapid: 95, fast: 80, average: 60, methodical: 40, deliberate: 25,
  };
  let score = tierScores[velocity.velocityTier] ?? 60;

  // Bonus for proven paradigm shifting
  if (velocity.provenParadigmShifter) score = Math.min(100, score + 15);

  // Bonus for accelerating trend
  if (velocity.recentTrend === "accelerating") score = Math.min(100, score + 10);
  if (velocity.recentTrend === "decelerating") score = Math.max(0, score - 10);

  // Penalty for low confidence (insufficient data)
  if (velocity.confidence === "low") score = Math.round(score * 0.7);
  if (velocity.confidence === "medium") score = Math.round(score * 0.85);

  return score;
}

function computeTrajectoryScore(trajectory: LearningTrajectory): number {
  const dirScores: Record<string, number> = {
    accelerating: 90, steady: 65, pivoting: 75, decelerating: 35,
  };
  let score = dirScores[trajectory.trajectoryDirection] ?? 60;

  // Continuous learning bonus
  if (trajectory.continuousLearningYears > 4) score = Math.min(100, score + 10);
  if (trajectory.continuousLearningYears > 6) score = Math.min(100, score + 5);

  // Active skills bonus (still learning, not stagnant)
  const activeRatio = trajectory.activeSkills.length /
    Math.max(trajectory.timeline.length, 1);
  score += Math.round(activeRatio * 15);

  return Math.min(100, score);
}

function computeAdjacencyScore(
  ttp: TimeToProductivityReport,
  candidateSkills: string[],
  requiredSkills: string[]
): number {
  if (requiredSkills.length === 0) return 100;

  const present = ttp.skillsPresent.length;
  const adjacent = ttp.skillsAdjacent.length;
  const total = requiredSkills.length;

  // Adjacent skills score heavily (they can learn quickly)
  const score = Math.round(((present * 3 + adjacent * 2) / (total * 3)) * 100);
  return Math.min(100, score);
}

// ─── Potential Headline Builder ───────────────────────────────────────────────

function buildPotentialHeadline(
  ttp: TimeToProductivityReport,
  velocity: LearningVelocityProfile,
  trajectory: LearningTrajectory
): string {
  if (ttp.potentialTier === "ready_now") {
    return "Has all required skills — ready to contribute immediately";
  }
  if (ttp.potentialTier === "near_ready") {
    const months = Math.round(ttp.totalWeeksToFullProductivity / 4);
    return `Near-ready: ${ttp.skillsAdjacent.length} gaps are adjacent skills, full productivity in ~${months} month${months > 1 ? "s" : ""}`;
  }
  if (velocity.provenParadigmShifter && velocity.strongestParadigmShift) {
    return `High-potential learner: proved they can cross paradigm boundaries (${velocity.strongestParadigmShift.from} → ${velocity.strongestParadigmShift.to})`;
  }
  if (velocity.velocityTier === "rapid" || velocity.velocityTier === "fast") {
    return `Fast learner: historically ${velocity.medianVelocityDays} days to proficiency — near gaps are acquirable quickly`;
  }
  const months = Math.round(ttp.totalWeeksToFullProductivity / 4);
  return `Strong potential: ${ttp.skillsPresent.length}/${ttp.skillsPresent.length + ttp.skillsMissing.length + ttp.skillsAdjacent.length} skills present, full readiness in ~${months} months`;
}

// ─── Learner Signals Extractor ────────────────────────────────────────────────

function extractLearnerSignals(
  velocity: LearningVelocityProfile,
  trajectory: LearningTrajectory,
  ttp: TimeToProductivityReport
): string[] {
  const signals: string[] = [];

  if (velocity.provenParadigmShifter && velocity.strongestParadigmShift) {
    signals.push(`Crossed paradigm boundary: ${velocity.strongestParadigmShift.from} → ${velocity.strongestParadigmShift.to} in ${Math.round(velocity.strongestParadigmShift.daysToProf / 30)} months`);
  }
  if (velocity.velocityTier === "rapid") {
    signals.push(`Rapid learner: median ${velocity.medianVelocityDays} days from first contact to substantive project`);
  } else if (velocity.velocityTier === "fast") {
    signals.push(`Fast learner: typically reaches proficiency in ${velocity.medianVelocityDays} days`);
  }
  if (trajectory.trajectoryDirection === "accelerating") {
    signals.push("Accelerating trajectory: recent skills acquired faster than historical average");
  }
  if (velocity.fastDomains.length > 0) {
    signals.push(`Natural aptitude in: ${velocity.fastDomains.slice(0, 2).join(", ")}`);
  }
  if (trajectory.keyTransitions.length > 0) {
    const best = trajectory.keyTransitions[0];
    signals.push(`Successful hard transition: ${best.fromSkill} → ${best.toSkill} (${best.monthsTaken} months, ${best.outcomeQuality})`);
  }
  if (ttp.skillsAdjacent.length > 0) {
    signals.push(`${ttp.skillsAdjacent.length} missing skills are adjacent to what they know — low-friction acquisition`);
  }
  if (trajectory.continuousLearningYears > 3) {
    signals.push(`${Math.round(trajectory.continuousLearningYears)} years of continuous learning — not a one-time learner`);
  }

  return signals;
}

// ─── Hiring Mode Classifier ───────────────────────────────────────────────────

function classifyHiringMode(
  ttp: TimeToProductivityReport,
  potentialScore: number
): { mode: PotentialProfile["hiringMode"]; rationale: string } {
  if (ttp.potentialTier === "ready_now" || ttp.potentialTier === "near_ready") {
    return {
      mode: "current_skills",
      rationale: "Hire for current skills — near-complete match with short ramp-up for any gaps",
    };
  }
  if (potentialScore >= 65 && ttp.totalWeeksToFullProductivity <= 20) {
    return {
      mode: "hybrid",
      rationale: "Hybrid hire — strong current foundation with specific learnable gaps. Pair with mentor on missing areas.",
    };
  }
  if (potentialScore >= 50 && ttp.potentialTier === "strong_potential") {
    return {
      mode: "potential_play",
      rationale: "Potential play — fewer current-skill matches but strong learning trajectory suggests they'll close gaps faster than typical candidates",
    };
  }
  return {
    mode: "potential_play",
    rationale: "Long-runway potential play — requires deliberate onboarding investment, but trajectory data supports the bet",
  };
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * scorePotential — the full learning trajectory pipeline.
 *
 * Takes GitHub repos + required skills → PotentialProfile with TTP estimates.
 *
 * Used by Agent 4 as a new ranking dimension (D9: Learning Potential, weight 0.12).
 * Also surfaces directly to the user as the "Potential & Learning Trajectory" card.
 */
export async function scorePotential(
  username: string,
  repos: GitHubRepo[],
  currentSkillNames: string[],
  requiredSkillNames: string[],
  depthRequired: DepthRequired = "proficient"
): Promise<PotentialProfile> {
  const candidateId = `CND_${username.slice(0, 8)}`;

  // Step 1: Build skill timeline from repo history
  const trajectory = buildSkillTimeline(repos);

  // Step 2: Measure historical learning velocity
  const velocity = detectLearningVelocity(trajectory);

  // Step 3: Estimate TTP for each required skill
  const resolvedCurrentSkills = currentSkillNames
    .map((s) => resolveSkillId(s) ?? s)
    .filter(Boolean);

  const ttp = estimateTimeToProductivity(
    candidateId,
    resolvedCurrentSkills,
    requiredSkillNames,
    velocity,
    trajectory,
    depthRequired
  );

  // Step 4: Compute dimension scores
  const ttpScore = computeTTPScore(ttp);
  const velocityScore = computeVelocityScore(velocity);
  const trajectoryScore = computeTrajectoryScore(trajectory);
  const adjacencyScore = computeAdjacencyScore(ttp, resolvedCurrentSkills, requiredSkillNames);

  // Composite potential score (weighted)
  const potentialScore = Math.round(
    ttpScore * 0.35 +
    velocityScore * 0.30 +
    trajectoryScore * 0.20 +
    adjacencyScore * 0.15
  );

  // Ranking dimension score (normalized 0–100 for D9 in Agent 4)
  const rankingDimensionScore = potentialScore;
  const rankingDimensionLabel =
    ttp.potentialTier === "ready_now" ? "Ready now" :
    ttp.potentialTier === "near_ready" ? "Near-ready" :
    ttp.potentialTier === "strong_potential" ? "Strong potential" :
    ttp.potentialTier === "longer_runway" ? "Longer runway" : "Major transition";

  const rankingDimensionEvidence = ttp.potentialNarrative;

  // Learner signals and risks
  const learnerSignals = extractLearnerSignals(velocity, trajectory, ttp);
  const learnerRisks = [
    velocity.slowDomains.length > 0 ? `Slower acquisition in: ${velocity.slowDomains.join(", ")}` : null,
    velocity.recentTrend === "decelerating" ? "Recent learning pace slower than historical average" : null,
    ttp.totalWeeksToFullProductivity > 26 ? `Full productivity estimated at ${Math.round(ttp.totalWeeksToFullProductivity / 4)} months — significant investment required` : null,
    velocity.sampleSize < 2 ? "Insufficient learning history to estimate velocity with high confidence" : null,
  ].filter(Boolean) as string[];

  const potentialHeadline = buildPotentialHeadline(ttp, velocity, trajectory);

  const potentialReasoning = [
    ttp.potentialNarrative,
    velocity.strongestParadigmShift
      ? `Learning history evidence: ${velocity.strongestParadigmShift.from} → ${velocity.strongestParadigmShift.to} in ${Math.round(velocity.strongestParadigmShift.daysToProf / 30)} months`
      : null,
    trajectory.lastParadigmShift
      ? `Most recent paradigm shift: ${trajectory.lastParadigmShift.from} → ${trajectory.lastParadigmShift.to}`
      : null,
    `Trajectory direction: ${trajectory.trajectoryDirection} (${Math.round(trajectory.skillsPerYear * 10) / 10} new skills/year over ${Math.round(trajectory.continuousLearningYears)} years)`,
  ].filter(Boolean) as string[];

  const { mode: hiringMode, rationale: hiringModeRationale } = classifyHiringMode(ttp, potentialScore);

  return {
    candidateId,
    username,
    trajectory,
    velocity,
    ttp,
    potentialScore,
    ttpdScore: ttpScore,
    velocityScore,
    trajectoryScore,
    adjacencyScore,
    rankingDimensionScore,
    rankingDimensionLabel,
    rankingDimensionEvidence,
    potentialHeadline,
    potentialReasoning,
    learnerSignals,
    learnerRisks,
    hiringMode,
    hiringModeRationale,
  };
}
