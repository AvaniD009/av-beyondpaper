/**
 * SKILL TRAJECTORY MAPPER
 * ─────────────────────────────────────────────────────────────────────────────
 * Reconstructs the candidate's skill acquisition timeline from GitHub data.
 *
 * GitHub is a learning history database. Every repo has a creation date.
 * The progression from "hello world" to "production-grade" in any technology
 * is directly observable in commit history and repo complexity growth.
 *
 * What we extract:
 *
 *   For each skill/technology the candidate has ever touched:
 *   - When did they FIRST appear in this skill? (first repo created_at)
 *   - When did they reach PROFICIENCY? (first substantive repo: size > 500KB, has tests, or got forked)
 *   - Are they STILL ACTIVE in this skill? (last commit < 6 months ago)
 *   - What skills DID THEY HAVE when they learned this one? (the "prerequisite context")
 *
 * This answers: "What was their learning path to get here?"
 * And by extension: "Can they continue along that trajectory to [required skill]?"
 *
 * Complexity slope detection:
 *   Early repos in a skill = small, no tests, minimal README.
 *   Later repos in a skill = large, CI, tests, contributors, depended upon.
 *   The slope from early → late tells us how fast they ramp.
 */

import type { GitHubRepo } from "@/lib/github/client";
import { resolveSkillId, getSkillNode, findShortestPath } from "./skill-graph";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillTimelineEntry {
  skillId: string;
  displayName: string;
  /** Date of first repo in this skill */
  firstSeenDate: string;
  /** Date of most substantive repo in this skill */
  proficiencyDate: string | null;
  /** Date of most recent repo in this skill */
  lastActiveDate: string;
  /** Whether still active (last activity < 180 days ago) */
  isActive: boolean;
  /** Months from first seen to proficiency (null if proficiency not reached) */
  monthsToProf: number | null;
  /** Number of repos in this skill */
  repoCount: number;
  /** Complexity score of earliest repo (1–10) */
  earlyComplexity: number;
  /** Complexity score of most recent repo (1–10) */
  latestComplexity: number;
  /** Growth slope: positive = leveling up, 0 = stagnant */
  complexitySlope: number;
  /** Skills the candidate already had when they started this one */
  prerequisiteContext: string[];
  /** Whether this skill was acquired as a solo project or via contribution to others */
  acquisitionMode: "solo_project" | "contribution" | "both" | "unknown";
}

export interface LearningTrajectory {
  /** All skills on the timeline, sorted chronologically */
  timeline: SkillTimelineEntry[];
  /** Skills learned (not just touched — have at least 1 substantive repo) */
  acquiredSkills: string[];
  /** Skills still actively used */
  activeSkills: string[];
  /** Skills that appear to be stale/abandoned */
  staleSkills: string[];
  /** Overall trajectory direction */
  trajectoryDirection: "accelerating" | "steady" | "decelerating" | "pivoting";
  /** The most recent paradigm shift (if any) */
  lastParadigmShift: {
    from: string;
    to: string;
    date: string;
    monthsTaken: number;
  } | null;
  /** Total skills acquired per year (learning rate over time) */
  skillsPerYear: number;
  /** How long they've been consistently learning new things */
  continuousLearningYears: number;
  /** The most important skill transitions that reveal learning ability */
  keyTransitions: SkillTransition[];
}

export interface SkillTransition {
  fromSkill: string;
  toSkill: string;
  /** Duration of the transition in months */
  monthsTaken: number;
  /** What percentage of from→to knowledge likely transferred */
  estimatedTransfer: number;
  /** Quality of the final outcome (did they produce a real project in toSkill?) */
  outcomeQuality: "real_project" | "contributions" | "experiments" | "unclear";
  /** Evidence: the repos that show this transition */
  evidenceRepos: string[];
}

// ─── Repo Complexity Scorer ───────────────────────────────────────────────────
// Approximates how complex/serious a repo is without reading the code.
// Uses available metadata: size, topics, description length, has_readme evidence.

function scoreRepoComplexity(repo: GitHubRepo): number {
  let score = 0;

  // Size signal (KB)
  if (repo.size > 10000) score += 3;
  else if (repo.size > 1000) score += 2;
  else if (repo.size > 200) score += 1;

  // Topic tags (self-labeling = some seriousness)
  score += Math.min(repo.topics.length * 0.4, 2);

  // Description quality
  if (repo.description && repo.description.length > 50) score += 1;
  if (repo.description && repo.description.length > 100) score += 0.5;

  // README presence inferred from deep-fetcher
  if (repo.readme_excerpt && repo.readme_excerpt.length > 200) score += 1.5;

  // Open issues = people use it
  if (repo.open_issues_count > 5) score += 1;

  // Stars are a community signal (we allow this here — it's not demographic)
  if (repo.stargazers_count > 50) score += 1;
  else if (repo.stargazers_count > 10) score += 0.5;

  return Math.min(10, Math.round(score * 10) / 10);
}

// ─── Skill Extractor ──────────────────────────────────────────────────────────
// Determines what skill(s) a repo represents.

function extractRepoSkills(repo: GitHubRepo): string[] {
  const skills: string[] = [];

  // Primary language
  if (repo.language) {
    const id = resolveSkillId(repo.language);
    if (id) skills.push(id);
  }

  // Topics that map to skills
  for (const topic of repo.topics) {
    const id = resolveSkillId(topic);
    if (id && !skills.includes(id)) skills.push(id);
  }

  // Repo name hints
  const nameLower = repo.name.toLowerCase().replace(/[-_]/g, " ");
  for (const word of nameLower.split(" ")) {
    const id = resolveSkillId(word);
    if (id && !skills.includes(id)) skills.push(id);
  }

  return skills;
}

// ─── Proficiency Detector ────────────────────────────────────────────────────
// Determines if a repo represents "proficiency-level" work.
// A repo is "substantive" if it has real content (not a tutorial/clone).

function isSubstantiveRepo(repo: GitHubRepo): boolean {
  if (repo.is_fork) return false;
  if (repo.size < 50) return false; // < 50KB = likely empty or trivial
  if (!repo.description && !repo.readme_excerpt) return false;
  return true;
}

// ─── Timeline Builder ─────────────────────────────────────────────────────────

/**
 * buildSkillTimeline — reconstructs the skill acquisition history from repos.
 *
 * Groups repos by skill, sorts by date, computes complexity progression.
 * Returns a chronological timeline of skill acquisitions.
 */
export function buildSkillTimeline(repos: GitHubRepo[]): LearningTrajectory {
  if (repos.length === 0) {
    return emptyTrajectory();
  }

  // Sort all repos chronologically
  const sorted = [...repos]
    .filter((r) => r.created_at)
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

  // Build per-skill repo lists
  const skillRepoMap = new Map<string, GitHubRepo[]>();
  for (const repo of sorted) {
    for (const skillId of extractRepoSkills(repo)) {
      if (!skillRepoMap.has(skillId)) skillRepoMap.set(skillId, []);
      skillRepoMap.get(skillId)!.push(repo);
    }
  }

  // Build timeline entries
  const entries: SkillTimelineEntry[] = [];
  const now = Date.now();

  for (const [skillId, skillRepos] of skillRepoMap) {
    if (skillRepos.length === 0) continue;

    const node = getSkillNode(skillId);
    if (!node) continue;

    const originals = skillRepos.filter((r) => !r.is_fork);
    if (originals.length === 0 && skillRepos.every((r) => r.is_fork)) continue; // only forks = skip

    const relevant = originals.length > 0 ? originals : skillRepos;
    const firstRepo = relevant[0];
    const lastRepo = relevant[relevant.length - 1];

    // Find first substantive repo (proficiency signal)
    const firstSubstantive = relevant.find(isSubstantiveRepo);

    // Complexity scores
    const earlyComplexity = scoreRepoComplexity(firstRepo);
    const latestComplexity = scoreRepoComplexity(lastRepo);

    const firstDate = firstRepo.created_at!;
    const lastDate = lastRepo.updated_at ?? lastRepo.created_at!;
    const profDate = firstSubstantive?.created_at ?? null;

    const monthsToProf = profDate
      ? Math.round((new Date(profDate).getTime() - new Date(firstDate).getTime()) / (1000 * 60 * 60 * 24 * 30))
      : null;

    const lastActive = new Date(lastDate).getTime();
    const daysSinceActive = (now - lastActive) / (1000 * 60 * 60 * 24);

    // Acquisition mode
    const hasSolo = originals.length > 0;
    const hasContrib = skillRepos.some((r) => r.is_fork);
    const acquisitionMode: SkillTimelineEntry["acquisitionMode"] =
      hasSolo && hasContrib ? "both" :
      hasSolo ? "solo_project" :
      hasContrib ? "contribution" : "unknown";

    entries.push({
      skillId,
      displayName: node.displayName,
      firstSeenDate: firstDate,
      proficiencyDate: profDate,
      lastActiveDate: lastDate,
      isActive: daysSinceActive < 180,
      monthsToProf,
      repoCount: relevant.length,
      earlyComplexity,
      latestComplexity,
      complexitySlope: latestComplexity - earlyComplexity,
      prerequisiteContext: [], // filled in below
      acquisitionMode,
    });
  }

  // Sort timeline chronologically
  entries.sort((a, b) => new Date(a.firstSeenDate).getTime() - new Date(b.firstSeenDate).getTime());

  // Fill prerequisite context: what skills existed before each new skill
  for (let i = 0; i < entries.length; i++) {
    entries[i].prerequisiteContext = entries
      .slice(0, i)
      .map((e) => e.skillId);
  }

  // Derived signals
  const active = entries.filter((e) => e.isActive).map((e) => e.skillId);
  const stale = entries.filter((e) => !e.isActive).map((e) => e.skillId);
  const acquired = entries.filter((e) => e.proficiencyDate !== null).map((e) => e.skillId);

  // Learning rate
  const yearSpan = entries.length > 1
    ? (new Date(entries[entries.length - 1].firstSeenDate).getTime() - new Date(entries[0].firstSeenDate).getTime()) / (1000 * 60 * 60 * 24 * 365)
    : 1;
  const skillsPerYear = yearSpan > 0 ? entries.length / yearSpan : entries.length;

  // Continuous learning detection
  const continuousLearningYears = yearSpan;

  // Trajectory direction
  const recentEntries = entries.slice(-3);
  const avgRecentSlope = recentEntries.reduce((a, e) => a + e.complexitySlope, 0) / Math.max(recentEntries.length, 1);
  const trajectoryDirection: LearningTrajectory["trajectoryDirection"] =
    recentEntries.some((e) => e.skillId !== entries[0].skillId) && avgRecentSlope > 1 ? "accelerating" :
    avgRecentSlope > 0 ? "steady" :
    entries.some((e, i) => i > 0 && getSkillNode(e.skillId)?.paradigms[0] !== getSkillNode(entries[i - 1].skillId)?.paradigms[0]) ? "pivoting" :
    "decelerating";

  // Key transitions
  const keyTransitions = extractKeyTransitions(entries);

  // Last paradigm shift
  const lastShift = findLastParadigmShift(entries);

  return {
    timeline: entries,
    acquiredSkills: acquired,
    activeSkills: active,
    staleSkills: stale,
    trajectoryDirection,
    lastParadigmShift: lastShift,
    skillsPerYear: Math.round(skillsPerYear * 10) / 10,
    continuousLearningYears: Math.round(continuousLearningYears * 10) / 10,
    keyTransitions,
  };
}

// ─── Key Transition Extractor ─────────────────────────────────────────────────

function extractKeyTransitions(entries: SkillTimelineEntry[]): SkillTransition[] {
  const transitions: SkillTransition[] = [];

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];

    // Only track transitions where we have substantive evidence
    if (!curr.proficiencyDate) continue;

    const months = Math.round(
      (new Date(curr.firstSeenDate).getTime() - new Date(prev.firstSeenDate).getTime()) /
      (1000 * 60 * 60 * 24 * 30)
    );

    if (months < 0) continue; // data anomaly

    const outcome: SkillTransition["outcomeQuality"] = curr.proficiencyDate
      ? "real_project"
      : curr.repoCount > 3 ? "experiments" : "unclear";

    // Estimate transfer from skill graph
    const path = findShortestPath(prev.skillId, curr.skillId);
    const transfer = path?.overallTransferPotential ?? 0.3;

    transitions.push({
      fromSkill: prev.skillId,
      toSkill: curr.skillId,
      monthsTaken: months,
      estimatedTransfer: transfer,
      outcomeQuality: outcome,
      evidenceRepos: [],
    });
  }

  // Sort by significance: hard transitions with good outcomes
  return transitions
    .filter((t) => t.monthsTaken <= 24) // cap at 2 years for relevance
    .sort((a, b) => {
      const scoreA = (1 - a.estimatedTransfer) * (a.outcomeQuality === "real_project" ? 2 : 1);
      const scoreB = (1 - b.estimatedTransfer) * (b.outcomeQuality === "real_project" ? 2 : 1);
      return scoreB - scoreA;
    })
    .slice(0, 5);
}

// ─── Paradigm Shift Detector ──────────────────────────────────────────────────

function findLastParadigmShift(entries: SkillTimelineEntry[]): LearningTrajectory["lastParadigmShift"] {
  for (let i = entries.length - 1; i >= 1; i--) {
    const curr = getSkillNode(entries[i].skillId);
    const prev = getSkillNode(entries[i - 1].skillId);
    if (!curr || !prev) continue;

    // Check for paradigm shift
    const sharedParadigms = curr.paradigms.filter((p) => prev.paradigms.includes(p));
    if (sharedParadigms.length === 0 || curr.domain !== prev.domain) {
      const months = Math.round(
        (new Date(entries[i].firstSeenDate).getTime() - new Date(entries[i - 1].firstSeenDate).getTime()) /
        (1000 * 60 * 60 * 24 * 30)
      );
      return {
        from: entries[i - 1].skillId,
        to: entries[i].skillId,
        date: entries[i].firstSeenDate,
        monthsTaken: months,
      };
    }
  }
  return null;
}

function emptyTrajectory(): LearningTrajectory {
  return {
    timeline: [], acquiredSkills: [], activeSkills: [], staleSkills: [],
    trajectoryDirection: "steady", lastParadigmShift: null,
    skillsPerYear: 0, continuousLearningYears: 0, keyTransitions: [],
  };
}
