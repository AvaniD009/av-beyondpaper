/**
 * NICHE FIT EVALUATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Answers the most important question: "Does this person's actual work
 * specifically meet what the querier is looking for?"
 *
 * This is separate from general profile analysis because:
 *   - A great engineer might be irrelevant to THIS query
 *   - A "mediocre" portfolio might have one deeply relevant project
 *   - Niche fit requires understanding the query's DEPTH requirements
 *
 * Evaluates:
 *   1. Commit depth in the specific niche (not just language/framework use)
 *   2. Problem-level match (solving the same class of problems)
 *   3. Evidence quality (are their niche contributions real, not tutorial-following?)
 *   4. Recency (is this knowledge current or stale?)
 *   5. Transferability (if not exact, how close is the adjacent expertise?)
 */

import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "@/lib/agents/bias-free-evaluator";
import type { NicheCommitAnalysis } from "@/lib/github/deep-fetcher";
import type { CodeQualityReport } from "@/lib/github/code-quality";
import type { QueryAnalysis } from "@/lib/agents/query-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NicheFitResult {
  /** 0–100: does their work match what the querier needs? */
  fitScore: number;

  /** Classification of how well they fit */
  fitLevel: "exact" | "strong" | "partial" | "adjacent" | "weak";

  /** Evidence that they've worked in the niche — specific, real */
  directEvidence: NicheEvidence[];

  /** Evidence that adjacent expertise would transfer */
  transferableEvidence: NicheEvidence[];

  /** Requirements from the query that are clearly met */
  requirementsMet: RequirementCheck[];

  /** Requirements from the query that are not met */
  requirementsNotMet: RequirementCheck[];

  /** The niche-specific analysis summary */
  nicheSummary: string;

  /** How long they've been working in this specific domain */
  domainTenure: string;

  /** Are their niche commits recent (last 12 months)? */
  isCurrentlyActive: boolean;

  /** Depth level: are they a user or a builder of the technology? */
  depthLevel: "creator" | "advanced_user" | "practitioner" | "learner";

  /** Recommendation for the recruiter */
  recruitmentNote: string;
}

export interface NicheEvidence {
  type: "commit" | "repo" | "pr" | "issue" | "gist" | "code_pattern" | "publication";
  description: string;
  url: string | null;
  strength: "strong" | "moderate" | "weak";
  nicheKeywords: string[]; // which required keywords this satisfies
}

export interface RequirementCheck {
  requirement: string;
  met: boolean;
  evidence: string | null;
  /** If not met exactly, is there an adjacent signal? */
  adjacentEvidence: string | null;
}

// ─── Requirement Extractor ────────────────────────────────────────────────────
// Converts query analysis into checkable requirements

function buildRequirementsChecklist(query: QueryAnalysis): string[] {
  const requirements: string[] = [];

  // Core required skills
  for (const skill of query.requiredSkills) {
    requirements.push(`Has demonstrated expertise in: ${skill}`);
  }

  // Domain fit
  for (const domain of query.domains.slice(0, 3)) {
    requirements.push(`Has worked in domain: ${domain}`);
  }

  // Seniority
  if (query.seniority !== "any") {
    requirements.push(`Seniority level: ${query.seniority}`);
  }

  // Language requirements
  if (query.languages.length > 0) {
    requirements.push(`Uses language(s): ${query.languages.join(", ")}`);
  }

  return requirements;
}

// ─── Commit Evidence Formatter ────────────────────────────────────────────────

function formatCommitEvidence(nicheAnalysis: NicheCommitAnalysis, username: string): string {
  if (nicheAnalysis.totalNicheCommits === 0) {
    return "No direct niche commits found in analyzed repositories.";
  }

  const sections: string[] = [];

  sections.push(`Niche-relevant repos: ${nicheAnalysis.nicheRepos.slice(0, 4).join(", ")}`);
  sections.push(`Total niche commits: ${nicheAnalysis.totalNicheCommits}`);
  sections.push(`Recent (12mo): ${nicheAnalysis.recentNicheCommits}`);

  if (nicheAnalysis.firstNicheCommitDate) {
    const years = Math.floor(
      (Date.now() - new Date(nicheAnalysis.firstNicheCommitDate).getTime()) /
        (1000 * 60 * 60 * 24 * 365)
    );
    sections.push(
      `Domain tenure: ${years > 0 ? `${years}+ years` : "< 1 year"} (first commit: ${nicheAnalysis.firstNicheCommitDate.slice(0, 10)})`
    );
  }

  if (nicheAnalysis.samples.length > 0) {
    sections.push("\nSample commit messages from niche repos:");
    for (const commit of nicheAnalysis.samples.slice(0, 8)) {
      const body = commit.messageBody ? ` — ${commit.messageBody.slice(0, 100)}` : "";
      sections.push(`  [${commit.repo}] ${commit.message}${body}`);
    }
  }

  return sections.join("\n");
}

// ─── Claude Niche Fit Analysis ────────────────────────────────────────────────

export async function evaluateNicheFit(
  query: QueryAnalysis,
  nicheAnalysis: NicheCommitAnalysis,
  codeQuality: CodeQualityReport,
  profileSummary: {
    username: string;
    headline: string;
    domains: string[];
    skills: Array<{ name: string; level: string; evidence: string }>;
    projectDescriptions: string[];
  }
): Promise<NicheFitResult> {
  const requirements = buildRequirementsChecklist(query);
  const commitEvidence = formatCommitEvidence(nicheAnalysis, profileSummary.username);

  const codePatterns = codeQuality.domainPatternsFound.length > 0
    ? `\nNiche code patterns found in sampled code:\n${codeQuality.domainPatternsFound.map((p) => `  - ${p}`).join("\n")}`
    : "\nNo niche code patterns could be extracted from sampled files.";

  const prompt = `You are evaluating whether an engineer's actual work meets a specific search query.

SEARCH QUERY:
Intent: ${query.rewrite.expertQuery}
Required skills: ${query.requiredSkills.join(", ")}
Domains needed: ${query.domains.join(", ")}
Languages: ${query.languages.join(", ") || "any"}

REQUIREMENTS CHECKLIST:
${requirements.map((r, i) => `${i + 1}. ${r}`).join("\n")}

ENGINEER PROFILE SUMMARY:
Headline: ${profileSummary.headline}
Their domains: ${profileSummary.domains.join(", ")}
Their skills: ${profileSummary.skills.map((s) => `${s.name} (${s.level}): ${s.evidence}`).join("; ")}
Projects: ${profileSummary.projectDescriptions.join(" | ")}

NICHE COMMIT EVIDENCE:
${commitEvidence}
${codePatterns}

CODE QUALITY SIGNALS:
Overall code score: ${codeQuality.overallScore}/10
Niche idiom score: ${codeQuality.nicheIdiomScore}/10
Production grade: ${codeQuality.isProductionGrade}
Green flags: ${codeQuality.greenFlags.join("; ")}
Red flags: ${codeQuality.redFlags.join("; ")}

Evaluate niche fit and return JSON:
{
  "fitScore": <0-100>,
  "fitLevel": "exact|strong|partial|adjacent|weak",
  "directEvidence": [
    {
      "type": "commit|repo|pr|issue|code_pattern",
      "description": "specific evidence of niche expertise",
      "url": null,
      "strength": "strong|moderate|weak",
      "nicheKeywords": ["keywords this satisfies from required skills"]
    }
  ],
  "transferableEvidence": [
    {
      "type": "commit|repo|code_pattern",
      "description": "adjacent expertise that would transfer to the niche",
      "url": null,
      "strength": "strong|moderate|weak",
      "nicheKeywords": ["keywords this partially satisfies"]
    }
  ],
  "requirementsMet": [
    {
      "requirement": "exact requirement text",
      "met": true,
      "evidence": "specific evidence",
      "adjacentEvidence": null
    }
  ],
  "requirementsNotMet": [
    {
      "requirement": "exact requirement text",
      "met": false,
      "evidence": null,
      "adjacentEvidence": "what they have that's close, if anything"
    }
  ],
  "nicheSummary": "2-3 sentence summary of how well they fit this specific niche",
  "domainTenure": "< 1 year|1-2 years|2-4 years|4+ years",
  "isCurrentlyActive": <true if niche commits in last 12 months>,
  "depthLevel": "creator|advanced_user|practitioner|learner",
  "recruitmentNote": "one sentence note for the recruiter — what makes this person worth contacting or not for THIS specific role"
}

IMPORTANT:
- depthLevel: "creator" = builds the tools others use. "advanced_user" = uses them expertly. "practitioner" = applies them competently. "learner" = exploring the area.
- fitScore 80+ = they've clearly done this work. 60-79 = strong adjacent, easily transfers. 40-59 = partial overlap, real gap. <40 = weak fit.
- Be specific in evidence — cite actual repo names, commit patterns, code findings.`;

  return callClaudeJSON<NicheFitResult>(prompt, {
    system: BIAS_FREE_SYSTEM_PROMPT,
    maxTokens: 2000,
  });
}
