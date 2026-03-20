/**
 * lib/agents.js — Multi-Agent Search & Analysis Pipeline
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  AGENT 1: QUERY PARSER                                      │
 * │  Natural language → GitHub search syntax                    │
 * ├─────────────────────────────────────────────────────────────┤
 * │  AGENT 2: USER DISCOVERER                                   │
 * │  GitHub Search API → list of candidate usernames            │
 * ├─────────────────────────────────────────────────────────────┤
 * │  AGENT 3: DATA FETCHER  (per-user)                          │
 * │  GitHub REST API → profile + repos + READMEs                │
 * ├─────────────────────────────────────────────────────────────┤
 * │  AGENT 4: SKILL ANALYZER  (per-user)                        │
 * │  Claude AI → structured JSON skill assessment               │
 * ├─────────────────────────────────────────────────────────────┤
 * │  AGENT 5: RANKER                                            │
 * │  Pure JS → sorts by relevanceScore, emits live              │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Deep profile uses a 6th agent invoked on-demand.
 */

import { searchUsers, fetchFullProfile, RateLimitError } from "./github"

// ─── Claude Client (calls our server-side proxy) ───────────────────────────

async function claude(system, user) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, user }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Claude API error ${res.status}`)
  }

  const { result, error } = await res.json()
  if (error) throw new Error(error)
  return result ?? {}
}

// ─── Agent 1: Query Parser ─────────────────────────────────────────────────

export async function agentQueryParser(naturalQuery) {
  const result = await claude(
    `You are a GitHub search API expert. Convert natural language engineering skill descriptions 
into optimal GitHub user search queries. Use GitHub search operators effectively.
RESPOND ONLY WITH VALID JSON — no markdown, no explanation.`,

    `Convert this to a GitHub user search query: "${naturalQuery}"

Available operators:
- language:python (main language)
- topic:machine-learning (repo topic)
- followers:>100 (min followers)
- repos:>10 (min public repos)
- location:india (location filter)

Rules:
- Combine 2-4 operators for precision
- Use followers:>50 minimum to filter active engineers
- Focus on technical skills not job titles
- If the query mentions a location, include it

Output JSON:
{
  "query": "language:rust topic:webassembly followers:>100",
  "rationale": "One sentence explaining the search strategy",
  "keySignals": ["signal1", "signal2"]
}`
  )

  return {
    query: result.query || naturalQuery,
    rationale: result.rationale || "",
    keySignals: result.keySignals || [],
  }
}

// ─── Agent 2: User Discoverer ──────────────────────────────────────────────

export async function agentDiscoverer(githubQuery) {
  return searchUsers(githubQuery, 12)
}

// ─── Agent 3: Data Fetcher ─────────────────────────────────────────────────

export async function agentDataFetcher(username) {
  return fetchFullProfile(username)
}

// ─── Agent 4: Skill Analyzer ───────────────────────────────────────────────

export async function agentSkillAnalyzer(profileData, originalQuery) {
  const { user, repos, readmes } = profileData

  const repoContext = repos
    .slice(0, 5)
    .map(
      (r, i) =>
        `[${r.name}] ⭐${r.stargazers_count} | 🍴${r.forks_count} | ${r.language || "N/A"}
Description: ${r.description || "none"}
README: ${readmes[i]?.slice(0, 700) || "N/A"}`
    )
    .join("\n\n---\n\n")

  const raw = await claude(
    `You are a senior engineering talent analyst. Assess GitHub profiles honestly and specifically.
Focus on demonstrated capability from real open-source work, not just follower counts.
RESPOND ONLY WITH VALID JSON — no markdown, no text outside the JSON object.`,

    `Analyze this GitHub engineer for the search: "${originalQuery}"

PROFILE:
Name: ${user.name || user.login} (@${user.login})
Bio: ${user.bio || "none"}
Location: ${user.location || "unknown"}
Company: ${user.company || "independent"}
Followers: ${user.followers} | Public repos: ${user.public_repos}
Account age: created ${user.created_at?.split("T")[0] ?? "unknown"}

TOP REPOS (sorted by stars):
${repoContext}

Return EXACTLY this JSON shape:
{
  "relevanceScore": 82,
  "skills": ["Python", "PyTorch", "CUDA"],
  "domainExpertise": "One sentence describing their primary technical domain",
  "problemSolvingStyle": "One sentence on how they approach engineering problems",
  "depth": "expert",
  "hiddenGem": false,
  "standoutProject": "repo-name",
  "standoutReason": "Why this project demonstrates exceptional engineering, specifically",
  "recommendation": "One sentence hire/consider/pass signal with the key reason"
}

depth must be exactly one of: "shallow" | "intermediate" | "deep" | "expert"
relevanceScore: 0–100 (match to the original query)
hiddenGem: true if high skill but low follower count (underrated engineer)`
  )

  return {
    relevanceScore: clamp(parseInt(raw.relevanceScore) || 50, 0, 100),
    skills: Array.isArray(raw.skills) ? raw.skills.slice(0, 8) : [],
    domainExpertise: raw.domainExpertise || "",
    problemSolvingStyle: raw.problemSolvingStyle || "",
    depth: ["shallow", "intermediate", "deep", "expert"].includes(raw.depth) ? raw.depth : "intermediate",
    hiddenGem: !!raw.hiddenGem,
    standoutProject: raw.standoutProject || "",
    standoutReason: raw.standoutReason || "",
    recommendation: raw.recommendation || "",
  }
}

// ─── Agent 5: Ranker (pure JS) ─────────────────────────────────────────────

export function agentRanker(results) {
  return [...results].sort((a, b) => b.analysis.relevanceScore - a.analysis.relevanceScore)
}

// ─── Agent 6: Deep Profiler (on-demand) ───────────────────────────────────

export async function agentDeepProfiler(profile, originalQuery) {
  const repoList = profile.repos
    ?.slice(0, 6)
    .map((r) => `${r.name} (⭐${r.stargazers_count}): ${r.description || "no description"} [${r.language || "?"}]`)
    .join("\n") || ""

  const raw = await claude(
    `You are a principal engineer conducting a deep technical talent assessment.
Be specific (reference actual repo names and technologies), honest (include real concerns),
and actionable (give concrete interview questions tied to their actual work).
RESPOND ONLY WITH VALID JSON — no markdown.`,

    `Write a deep technical profile for @${profile.login}
Search context: "${originalQuery}"

GitHub data:
- Bio: ${profile.githubData?.bio || "none"}
- Location: ${profile.githubData?.location || "unknown"}
- Company: ${profile.githubData?.company || "independent"}
- Followers: ${profile.githubData?.followers}
- Repos: ${profile.githubData?.public_repos}

Repositories:
${repoList}

Return this JSON:
{
  "headline": "One powerful sentence capturing what makes this engineer distinctive",
  "technicalStrengths": [
    "Specific strength with evidence from their repos",
    "Another specific strength",
    "Third strength"
  ],
  "uniqueInsights": [
    "Non-obvious insight about their work or approach",
    "Something most recruiters would miss"
  ],
  "redFlags": [
    "Any legitimate concern, or empty array if none"
  ],
  "greenFlags": [
    "Strong positive signal from their work",
    "Another green flag"
  ],
  "topProjects": [
    {
      "name": "repo-name",
      "impact": "What problem does it solve and at what scale",
      "techDetails": "Specific technical decisions that show engineering depth"
    },
    {
      "name": "repo-name-2",
      "impact": "What problem does it solve",
      "techDetails": "Technical details"
    }
  ],
  "careerTrajectory": "Assessment of their growth direction, momentum, and where they're headed",
  "hiringRecommendation": "strong hire",
  "riskAssessment": "Honest hiring risk/mitigation analysis (2-3 sentences)",
  "interviewQuestions": [
    "Specific technical question referencing their actual work (e.g., 'In repo-x, you chose Y over Z — walk me through that decision')",
    "Another targeted question probing their depth",
    "A question to surface their collaborative style or approach to tradeoffs"
  ]
}

hiringRecommendation must be exactly one of: "strong hire" | "consider" | "pass"`
  )

  return {
    headline: raw.headline || "",
    technicalStrengths: raw.technicalStrengths || [],
    uniqueInsights: raw.uniqueInsights || [],
    redFlags: raw.redFlags || [],
    greenFlags: raw.greenFlags || [],
    topProjects: raw.topProjects || [],
    careerTrajectory: raw.careerTrajectory || "",
    hiringRecommendation: ["strong hire", "consider", "pass"].includes(raw.hiringRecommendation)
      ? raw.hiringRecommendation
      : "consider",
    riskAssessment: raw.riskAssessment || "",
    interviewQuestions: raw.interviewQuestions || [],
  }
}

// ─── Main Pipeline Orchestrator ────────────────────────────────────────────

/**
 * Runs the full 5-agent search pipeline.
 *
 * @param {string} query - Natural language search query
 * @param {Object} callbacks
 * @param {Function} callbacks.onProgress - ({ stage, label, pct, detail }) => void
 * @param {Function} callbacks.onResult   - (sortedResults[]) => void  — called after each user
 * @param {AbortSignal} callbacks.signal  - For cancellation
 */
export async function runSearchPipeline(query, { onProgress, onResult, signal }) {
  const emit = (stage, label, pct, detail = "") => {
    if (!signal?.aborted) onProgress({ stage, label, pct, detail })
  }

  // ── Agent 1: Parse query ──
  emit("parse", "Agent 1 → Parsing search intent", 5)
  const { query: ghQuery, rationale } = await agentQueryParser(query)
  emit("parse", "Query parsed", 12, rationale || ghQuery)

  // ── Agent 2: Discover users ──
  emit("discover", "Agent 2 → Scanning GitHub", 15, ghQuery)
  let users = []
  try {
    users = await agentDiscoverer(ghQuery)
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-fatal: return empty results
    users = []
  }

  if (!users.length) {
    emit("done", "No matching engineers found", 100)
    return []
  }

  const total = Math.min(users.length, 10)
  emit("discover", `Found ${users.length} candidates`, 20, `Analyzing top ${total}`)

  const results = []

  // ── Agents 3+4: Fetch & Analyze each user ──
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break

    const username = users[i].login
    const basePct = 20 + (i / total) * 75

    emit("fetch", `Agent 3 → Fetching @${username}`, basePct, `Profile ${i + 1} of ${total}`)

    try {
      const profileData = await agentDataFetcher(username)

      if (signal?.aborted) break

      emit("analyze", `Agent 4 → Analyzing @${username}`, basePct + 3)
      const analysis = await agentSkillAnalyzer(profileData, query)

      results.push({
        id: username,
        login: username,
        avatar_url: users[i].avatar_url,
        html_url: users[i].html_url,
        githubData: profileData.user,
        repos: profileData.repos,
        readmes: profileData.readmes,
        analysis,
        searchQuery: query,
        analyzedAt: new Date().toISOString(),
      })

      // ── Agent 5: Rank & emit live ──
      onResult(agentRanker(results))
    } catch (err) {
      // Non-fatal: skip this user, log and continue
      console.warn(`[agent] Skipping @${username}: ${err.message}`)
    }
  }

  emit("done", "Analysis complete", 100, `${results.length} engineers profiled`)
  return agentRanker(results)
}

// ─── Utilities ─────────────────────────────────────────────────────────────

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
