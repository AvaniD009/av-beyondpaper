/**
 * COGNITIVE STYLE ANALYZER
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyzes HOW an engineer thinks when they write code — their cognitive
 * signature — not just WHAT they wrote.
 *
 * Two engineers can both "know Rust." One thinks in terms of ownership graphs
 * before touching the keyboard. The other reaches for clone() first and
 * optimizes later. Same skill on a resume. Completely different mind.
 *
 * This module extracts signals from commit messages, PR descriptions, issue
 * reports, code comments, and diff patterns to answer:
 *
 *   "What does this person's internal monologue look like when they encounter
 *    a hard problem?"
 *
 * Cognitive dimensions analyzed:
 *
 *   1. PROBLEM DECOMPOSITION STYLE
 *      → Do they break problems top-down or bottom-up?
 *      → Do commits show incremental refinement or large-batch rewrites?
 *      → Evidence: commit size distribution, refactor-to-feature ratio
 *
 *   2. ABSTRACTION PREFERENCE
 *      → Do they reach for generic solutions or specific ones?
 *      → Do they build their own primitives or compose existing ones?
 *      → Evidence: trait/interface usage, utility function creation patterns
 *
 *   3. ERROR REASONING DEPTH
 *      → Do they treat errors as branches to handle or as exceptional states?
 *      → Do they propagate errors richly or swallow them?
 *      → Evidence: error handling patterns in sampled code, Result/Option usage
 *
 *   4. TEST-FIRST vs TEST-AFTER THINKING
 *      → Evidence: git history — do test files appear before/after impl files?
 *      → Commit message patterns: "add test for..." before "implement..."
 *
 *   5. NAMING PRECISION
 *      → Do variable/function names describe intent or implementation?
 *      → "processData" vs "normalizeIncomingEventTimestamps"
 *      → Evidence: sampled code identifier analysis
 *
 *   6. COMMENT PHILOSOPHY
 *      → Do comments explain WHY or WHAT?
 *      → "// increment i" vs "// skip the sentinel value at index 0"
 *      → Evidence: code comment samples
 *
 *   7. CHANGE REASONING (commit message quality)
 *      → Do commit messages describe the change or the reason for the change?
 *      → "fix bug" vs "prevent double-free when connection resets mid-handshake"
 *      → Evidence: commit message corpus analysis
 *
 *   8. COLLABORATION STYLE
 *      → Do PR descriptions invite discussion or announce decisions?
 *      → Do they ask questions in issues or assert conclusions?
 *      → Evidence: PR body analysis, issue language analysis
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "./bias-free-evaluator";
import type { CommitSample, PullRequestSample, IssueSample } from "@/lib/github/deep-fetcher";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CognitiveDimension =
  | "problem_decomposition"
  | "abstraction_preference"
  | "error_reasoning"
  | "test_discipline"
  | "naming_precision"
  | "comment_philosophy"
  | "change_reasoning"
  | "collaboration_style";

export type CognitiveStyle =
  | "systems_thinker"      // thinks in invariants, contracts, ownership
  | "pragmatic_builder"    // ships first, refines with evidence
  | "research_oriented"    // explores design space before committing
  | "incremental_refiner"  // small safe changes, constant improvement
  | "architectural"        // designs abstractions before implementations
  | "domain_specialist";   // deep niche knowledge, narrow but very deep

export interface CognitiveDimensionScore {
  dimension: CognitiveDimension;
  /** 1–10 score for this dimension */
  score: number;
  /** Human-readable label for this score */
  label: string;
  /** The specific evidence that drove this assessment */
  evidence: string[];
  /** Direct quote (≤ 120 chars) from their actual work that best illustrates this */
  bestQuote: string | null;
  /** What this reveals about how they approach problems */
  interpretation: string;
}

export interface CommitMessageAnalysis {
  /** Distribution of commit message quality */
  qualityDistribution: {
    architectural: number;   // explains WHY the change was made + tradeoffs
    descriptive: number;     // explains WHAT changed clearly
    adequate: number;        // minimal but not misleading
    terse: number;           // "fix", "update", "wip" level
  };
  /** Most sophisticated commit message found (reveals depth of thought) */
  bestCommitMessage: string | null;
  /** Example of a commit that shows problem-solving reasoning */
  problemSolvingExample: string | null;
  /** Patterns detected in commit messages */
  patterns: string[];
  /** Average message length (proxy for communication investment) */
  averageMessageLength: number;
}

export interface ThoughtPatternSignal {
  /** The pattern name */
  pattern: string;
  /** How strongly this pattern appears (1–10) */
  strength: number;
  /** Example from their actual work */
  example: string | null;
  /** What this pattern reveals about their engineering mindset */
  mindsetSignal: string;
}

export interface CognitiveStyleProfile {
  username: string;

  /** Primary cognitive style — their dominant engineering personality */
  primaryStyle: CognitiveStyle;
  /** Secondary style — how they adapt in different contexts */
  secondaryStyle: CognitiveStyle | null;

  /** Per-dimension scores */
  dimensions: CognitiveDimensionScore[];

  /** Commit message quality analysis */
  commitAnalysis: CommitMessageAnalysis;

  /** Specific thought patterns extracted from their work */
  thoughtPatterns: ThoughtPatternSignal[];

  /** How they approach uncertainty and unknowns */
  uncertaintyApproach: string;

  /** Their apparent mental model when debugging */
  debuggingMindset: string;

  /** The cognitive fingerprint — 2-3 sentences that capture their unique way of thinking */
  cognitiveFingerprint: string;

  /**
   * Role fit signals: which types of engineering problems would
   * align with their cognitive style?
   */
  bestFitProblemTypes: string[];

  /**
   * Potential friction points: where their cognitive style might
   * create friction in certain environments
   */
  potentialFriction: string[];

  /** Overall cognitive depth score (0–100) */
  cognitiveDepthScore: number;
}

// ─── Commit Message Analyzer ──────────────────────────────────────────────────

function analyzeCommitMessages(commits: CommitSample[]): CommitMessageAnalysis {
  if (commits.length === 0) {
    return {
      qualityDistribution: { architectural: 0, descriptive: 0, adequate: 0, terse: 0 },
      bestCommitMessage: null,
      problemSolvingExample: null,
      patterns: [],
      averageMessageLength: 0,
    };
  }

  // Quality classification heuristics
  const ARCHITECTURAL_SIGNALS = [
    /\bwhy\b|\bbecause\b|\bto avoid\b|\bprevents?\b|\bensures?\b|\bguarantees?\b/i,
    /trade.?off|vs\.?|instead of|rather than/i,
    /\binvariant\b|\bcontract\b|\bprecondition\b|\bpostcondition\b/i,
    /\bO\([^)]+\)|\bperformance\b.*\bimprove|\boptimize\b/i,
    /\brace condition\b|\bdeadlock\b|\bliveness\b|\bsafety\b/i,
  ];

  const DESCRIPTIVE_SIGNALS = [
    /^(add|implement|refactor|extract|move|rename|update|remove|fix)\b.{15,}/i,
    /\bsupport\b.{10,}|\benable\b.{10,}|\ballow\b.{10,}/i,
  ];

  const TERSE_PATTERNS = /^(fix|update|wip|misc|todo|cleanup|refactor|typo|test|lint)\.?$/i;

  let architectural = 0, descriptive = 0, adequate = 0, terse = 0;
  let bestMsg: string | null = null;
  let bestMsgScore = 0;
  let problemSolvingExample: string | null = null;
  const patterns: string[] = [];

  for (const commit of commits) {
    const fullMsg = [commit.message, commit.messageBody].filter(Boolean).join(" ").trim();

    if (TERSE_PATTERNS.test(commit.message.trim())) {
      terse++;
    } else if (ARCHITECTURAL_SIGNALS.some((p) => p.test(fullMsg))) {
      architectural++;
      const score = fullMsg.length + (commit.messageBody ? 10 : 0);
      if (score > bestMsgScore) {
        bestMsgScore = score;
        bestMsg = fullMsg.slice(0, 200);
      }
      if (fullMsg.match(/\bbecause\b|\bto avoid\b|\bprevents?\b/i) && !problemSolvingExample) {
        problemSolvingExample = fullMsg.slice(0, 200);
      }
    } else if (DESCRIPTIVE_SIGNALS.some((p) => p.test(fullMsg))) {
      descriptive++;
    } else {
      adequate++;
    }
  }

  const total = commits.length;
  const avgLen = commits.reduce((a, c) => a + c.message.length, 0) / total;

  // Detect patterns
  if (architectural / total > 0.3) patterns.push("Explains reasoning behind changes, not just the changes");
  if (terse / total > 0.6) patterns.push("Terse commit style — prefers code to speak over messages");
  if (commits.some((c) => c.messageBody && c.messageBody.length > 100)) patterns.push("Uses commit body for extended explanations");
  if (commits.filter((c) => /\bclose[sd]?\b.*#\d+|\bfix(e[sd])?\b.*#\d+/i.test(c.message)).length > 0) {
    patterns.push("Links commits to issues — structured workflow");
  }

  return {
    qualityDistribution: { architectural, descriptive, adequate, terse },
    bestCommitMessage: bestMsg,
    problemSolvingExample,
    patterns,
    averageMessageLength: Math.round(avgLen),
  };
}

// ─── Claude Cognitive Analysis ────────────────────────────────────────────────

async function runCognitiveAnalysis(
  username: string,
  commits: CommitSample[],
  prs: PullRequestSample[],
  issues: IssueSample[],
  commitAnalysis: CommitMessageAnalysis,
  codeSnippets: string[]
): Promise<Omit<CognitiveStyleProfile, "username" | "commitAnalysis">> {

  const commitExamples = commits
    .slice(0, 12)
    .map((c) => {
      const body = c.messageBody ? `\n  [body] ${c.messageBody.slice(0, 120)}` : "";
      const diff = c.diffSnippet ? `\n  [code] ${c.diffSnippet.slice(0, 200)}` : "";
      return `• ${c.message}${body}${diff}`;
    })
    .join("\n");

  const prExamples = prs
    .slice(0, 5)
    .filter((pr) => pr.body && pr.body.length > 50)
    .map((pr) => `• [${pr.state}] "${pr.title}"\n  ${(pr.body ?? "").slice(0, 250)}`)
    .join("\n\n");

  const issueExamples = issues
    .slice(0, 5)
    .filter((i) => i.body && i.body.length > 50)
    .map((i) => `• "${i.title}"\n  ${(i.body ?? "").slice(0, 250)}`)
    .join("\n\n");

  const codeSection = codeSnippets
    .slice(0, 3)
    .map((s, i) => `--- Code Sample ${i + 1} ---\n${s.slice(0, 600)}`)
    .join("\n\n");

  const prompt = `Analyze the cognitive style and thinking patterns of this engineer from their actual work artifacts.

You are not evaluating quality. You are reading HOW they think — their cognitive fingerprint.

COMMIT MESSAGES (${commits.length} commits, ${commitAnalysis.qualityDistribution.architectural} architectural-level):
${commitExamples || "No commits available"}

COMMIT PATTERNS DETECTED:
${commitAnalysis.patterns.join(", ") || "none"}

BEST COMMIT MESSAGE:
${commitAnalysis.bestCommitMessage ?? "N/A"}

PULL REQUEST DESCRIPTIONS:
${prExamples || "No PR descriptions available"}

ISSUE REPORTS:
${issueExamples || "No issues available"}

CODE SAMPLES:
${codeSection || "No code samples available"}

Analyze these artifacts and return JSON:
{
  "primaryStyle": "systems_thinker|pragmatic_builder|research_oriented|incremental_refiner|architectural|domain_specialist",
  "secondaryStyle": "<same options or null>",
  "dimensions": [
    {
      "dimension": "problem_decomposition|abstraction_preference|error_reasoning|test_discipline|naming_precision|comment_philosophy|change_reasoning|collaboration_style",
      "score": <1-10>,
      "label": "short label like 'Top-down decomposer' or 'Patch-and-iterate'",
      "evidence": ["specific evidence from their actual work, not generic observations"],
      "bestQuote": "exact quote ≤120 chars from their commit/PR/issue/code that best shows this, or null",
      "interpretation": "what this tells us about how they approach engineering problems"
    }
  ],
  "thoughtPatterns": [
    {
      "pattern": "pattern name",
      "strength": <1-10>,
      "example": "direct quote or reference from their work",
      "mindsetSignal": "what this pattern reveals about engineering mindset"
    }
  ],
  "uncertaintyApproach": "how they handle unknowns — cite specific evidence",
  "debuggingMindset": "their apparent mental model when debugging — cite evidence",
  "cognitiveFingerprint": "2-3 sentences capturing their unique way of thinking — must be specific to THIS person, not generic",
  "bestFitProblemTypes": ["2-4 specific types of engineering problems that align with their style"],
  "potentialFriction": ["1-2 environments or problem types where their style might create friction"],
  "cognitiveDepthScore": <0-100, reflects complexity of thought shown in artifacts>
}

BIAS RULE: Do not infer cognitive style from employer, university, location, or name. Only from the artifacts provided.`;

  return callClaudeJSON<Omit<CognitiveStyleProfile, "username" | "commitAnalysis">>(
    prompt,
    {
      system: BIAS_FREE_SYSTEM_PROMPT,
      operation: "profile_synthesize",
      maxTokens: 2500,
    }
  );
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * analyzeCognitiveStyle — extracts the engineer's thinking fingerprint.
 *
 * This goes beyond "knows X" to answer "HOW do they think about X?"
 * Two engineers with identical skills can have completely different cognitive
 * styles — this module makes that difference visible and rankable.
 *
 * Used by Agent 4 to add a cognitive alignment dimension to rankings.
 */
export async function analyzeCognitiveStyle(
  username: string,
  commits: CommitSample[],
  prs: PullRequestSample[],
  issues: IssueSample[],
  codeSnippets: string[] = []
): Promise<CognitiveStyleProfile> {
  const commitAnalysis = analyzeCommitMessages(commits);
  const profile = await runCognitiveAnalysis(
    username, commits, prs, issues, commitAnalysis, codeSnippets
  );

  return { username, commitAnalysis, ...profile };
}
