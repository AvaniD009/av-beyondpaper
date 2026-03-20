/**
 * GITHUB DEEP FETCHER
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches every signal layer from GitHub that Agent 3 needs:
 *   - Commit history with messages + diffs (sampled)
 *   - Pull request history (what they propose and how they describe it)
 *   - Issue history (how they reason about problems)
 *   - Gists (quick scripts reveal domain intuition)
 *   - Pinned repos (what they want the world to see)
 *   - Repo file trees (architecture, test structure, CI config)
 *   - Code search (their actual code in a niche)
 *   - Contribution graph (consistency over time)
 */

import { octokit } from "./client";
import type { GitHubRepo } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommitSample {
  sha: string;
  message: string;          // first line only
  messageBody: string;      // full body, trimmed
  repo: string;
  date: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  /** Sampled diff snippet (first meaningful file changed, ≤300 chars) */
  diffSnippet: string | null;
}

export interface PullRequestSample {
  title: string;
  body: string | null;      // description they wrote — reveals communication depth
  state: "open" | "closed" | "merged";
  repo: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  createdAt: string;
  /** Whether it was merged — signals code quality acceptance */
  merged: boolean;
}

export interface IssueSample {
  title: string;
  body: string | null;      // their issue description — reveals analytical depth
  repo: string;
  state: "open" | "closed";
  labels: string[];
  createdAt: string;
  /** Comments they left on OTHERS' issues — reveals collaborative depth */
  isComment: boolean;
}

export interface GistSample {
  description: string | null;
  files: string[];          // filenames
  language: string | null;
  content: string | null;   // first 500 chars
  createdAt: string;
}

export interface RepoStructure {
  repoName: string;
  /** Top-level file/dir names — reveals architecture conventions */
  topLevelPaths: string[];
  /** Detected patterns from structure */
  hasTests: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  hasDockerfile: boolean;
  hasMakefile: boolean;
  hasBenchmarks: boolean;
  hasExamples: boolean;
  hasChangelog: boolean;
  hasContributing: boolean;
  /** Detected test framework from file names */
  testFramework: string | null;
  /** Detected CI system */
  ciSystem: string | null;
}

export interface NicheCommitAnalysis {
  /** Total commits found for the niche keywords */
  totalNicheCommits: number;
  /** Commits from last 12 months */
  recentNicheCommits: number;
  /** Repos where niche work happened */
  nicheRepos: string[];
  /** Sample commit messages with niche signals */
  samples: CommitSample[];
  /** First commit in this niche (longevity signal) */
  firstNicheCommitDate: string | null;
  /** Last commit in this niche (recency signal) */
  lastNicheCommitDate: string | null;
}

export interface DeepGitHubData {
  username: string;
  /** Pinned repos (most important signal — curated by the engineer) */
  pinnedRepos: GitHubRepo[];
  /** Sample commits across their top repos */
  commitSamples: CommitSample[];
  /** Their PR history — what they've proposed */
  prSamples: PullRequestSample[];
  /** Their issue history — how they reason */
  issueSamples: IssueSample[];
  /** Their gists — quick domain intuition */
  gistSamples: GistSample[];
  /** File tree analysis of top repos */
  repoStructures: RepoStructure[];
  /** Deep niche-specific commit analysis (per query domain) */
  nicheAnalysis: NicheCommitAnalysis;
  /** Contribution streak signals */
  contributionSignals: {
    activeWeeksLast6Months: number;
    longestStreak: number;
    averageWeeklyCommits: number;
  };
}

// ─── Pinned Repos (via GraphQL) ───────────────────────────────────────────────
// Pinned repos are what the engineer CHOSE to highlight — highest-intent signal

export async function getPinnedRepos(username: string): Promise<GitHubRepo[]> {
  try {
    const query = `
      query ($login: String!) {
        user(login: $login) {
          pinnedItems(first: 6, types: REPOSITORY) {
            nodes {
              ... on Repository {
                name
                description
                url
                primaryLanguage { name }
                stargazerCount
                forkCount
                repositoryTopics(first: 10) {
                  nodes { topic { name } }
                }
                updatedAt
                createdAt
                diskUsage
                openIssues: issues(states: OPEN) { totalCount }
                isFork
              }
            }
          }
        }
      }
    `;

    const result = await octokit.graphql<{
      user: {
        pinnedItems: {
          nodes: Array<{
            name: string;
            description: string | null;
            url: string;
            primaryLanguage: { name: string } | null;
            stargazerCount: number;
            forkCount: number;
            repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
            updatedAt: string;
            createdAt: string;
            diskUsage: number;
            openIssues: { totalCount: number };
            isFork: boolean;
          }>;
        };
      };
    }>(query, { login: username });

    return result.user.pinnedItems.nodes.map((r) => ({
      name: r.name,
      full_name: `${username}/${r.name}`,
      description: r.description,
      html_url: r.url,
      language: r.primaryLanguage?.name ?? null,
      stargazers_count: r.stargazerCount,
      forks_count: r.forkCount,
      topics: r.repositoryTopics.nodes.map((t) => t.topic.name),
      updated_at: r.updatedAt,
      created_at: r.createdAt,
      size: r.diskUsage,
      open_issues_count: r.openIssues.totalCount,
      is_fork: r.isFork,
    }));
  } catch {
    return [];
  }
}

// ─── Commit Samples ───────────────────────────────────────────────────────────
// Fetch commit samples from top 5 repos — message + minimal diff snippet

export async function getCommitSamples(
  username: string,
  repos: GitHubRepo[],
  limit = 30
): Promise<CommitSample[]> {
  const samples: CommitSample[] = [];
  const topRepos = repos.filter((r) => !r.is_fork).slice(0, 5);

  await Promise.allSettled(
    topRepos.map(async (repo) => {
      try {
        const [owner, repoName] = repo.full_name.split("/");
        const { data: commits } = await octokit.repos.listCommits({
          owner,
          repo: repoName,
          author: username,
          per_page: 10,
        });

        for (const commit of commits.slice(0, 6)) {
          const message = commit.commit.message;
          const firstLine = message.split("\n")[0].trim();
          const body = message.split("\n").slice(1).join("\n").trim();

          // Fetch diff for first commit to get depth signal (rate-limit aware)
          let diffSnippet: string | null = null;
          if (samples.length < 5) {
            try {
              const { data: detail } = await octokit.repos.getCommit({
                owner,
                repo: repoName,
                ref: commit.sha,
              });
              const firstFile = detail.files?.[0];
              if (firstFile?.patch) {
                diffSnippet = firstFile.patch.slice(0, 400);
              }
            } catch { /* skip diff */ }
          }

          samples.push({
            sha: commit.sha.slice(0, 8),
            message: firstLine,
            messageBody: body,
            repo: repo.name,
            date: commit.commit.author?.date ?? "",
            additions: commit.stats?.additions ?? 0,
            deletions: commit.stats?.deletions ?? 0,
            filesChanged: commit.files?.length ?? 0,
            diffSnippet,
          });
        }
      } catch { /* continue */ }
    })
  );

  return samples.slice(0, limit);
}

// ─── Pull Request Samples ─────────────────────────────────────────────────────

export async function getPullRequestSamples(
  username: string,
  limit = 10
): Promise<PullRequestSample[]> {
  try {
    // Search for PRs created by this user across GitHub
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `author:${username} type:pr`,
      sort: "created",
      order: "desc",
      per_page: Math.min(limit, 15),
    });

    return data.items.map((pr) => ({
      title: pr.title,
      body: pr.body ? pr.body.slice(0, 600) : null,
      state: (pr.state as "open" | "closed"),
      repo: pr.repository_url?.split("/").slice(-1)[0] ?? "unknown",
      additions: 0, // would need extra call
      deletions: 0,
      changedFiles: 0,
      labels: pr.labels?.map((l) => (typeof l === "string" ? l : l.name ?? "")) ?? [],
      createdAt: pr.created_at,
      merged: !!pr.pull_request?.merged_at,
    }));
  } catch {
    return [];
  }
}

// ─── Issue Samples ────────────────────────────────────────────────────────────
// Their issue descriptions and comments reveal analytical depth

export async function getIssueSamples(
  username: string,
  limit = 10
): Promise<IssueSample[]> {
  try {
    const { data } = await octokit.search.issuesAndPullRequests({
      q: `author:${username} type:issue`,
      sort: "created",
      order: "desc",
      per_page: Math.min(limit, 12),
    });

    return data.items.map((issue) => ({
      title: issue.title,
      body: issue.body ? issue.body.slice(0, 500) : null,
      repo: issue.repository_url?.split("/").slice(-1)[0] ?? "unknown",
      state: issue.state as "open" | "closed",
      labels: issue.labels?.map((l) => (typeof l === "string" ? l : l.name ?? "")) ?? [],
      createdAt: issue.created_at,
      isComment: false,
    }));
  } catch {
    return [];
  }
}

// ─── Gist Samples ─────────────────────────────────────────────────────────────

export async function getGistSamples(
  username: string,
  limit = 6
): Promise<GistSample[]> {
  try {
    const { data } = await octokit.gists.listForUser({
      username,
      per_page: Math.min(limit, 10),
    });

    return await Promise.all(
      data.slice(0, limit).map(async (gist) => {
        const files = Object.keys(gist.files ?? {});
        const firstFile = Object.values(gist.files ?? {})[0];
        let content: string | null = null;

        if (firstFile?.raw_url && files.length > 0) {
          try {
            const resp = await fetch(firstFile.raw_url);
            if (resp.ok) {
              const text = await resp.text();
              content = text.slice(0, 500);
            }
          } catch { /* skip */ }
        }

        return {
          description: gist.description ?? null,
          files,
          language: firstFile?.language ?? null,
          content,
          createdAt: gist.created_at ?? "",
        };
      })
    );
  } catch {
    return [];
  }
}

// ─── Repo File Structure ──────────────────────────────────────────────────────
// Top-level tree reveals architecture, test discipline, CI practices

export async function getRepoStructure(
  owner: string,
  repo: string
): Promise<RepoStructure> {
  const base: RepoStructure = {
    repoName: repo,
    topLevelPaths: [],
    hasTests: false,
    hasCI: false,
    hasDocs: false,
    hasDockerfile: false,
    hasMakefile: false,
    hasBenchmarks: false,
    hasExamples: false,
    hasChangelog: false,
    hasContributing: false,
    testFramework: null,
    ciSystem: null,
  };

  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: "" });
    if (!Array.isArray(data)) return base;

    const names = data.map((f) => f.name.toLowerCase());
    base.topLevelPaths = names.slice(0, 30);

    base.hasTests = names.some((n) => ["tests", "test", "__tests__", "spec", "specs"].includes(n));
    base.hasDocs = names.some((n) => ["docs", "doc", "documentation"].includes(n));
    base.hasDockerfile = names.includes("dockerfile");
    base.hasMakefile = names.includes("makefile");
    base.hasBenchmarks = names.some((n) => ["bench", "benches", "benchmarks", "perf"].includes(n));
    base.hasExamples = names.some((n) => ["examples", "example", "demos", "demo", "samples"].includes(n));
    base.hasChangelog = names.some((n) => n.startsWith("changelog") || n.startsWith("history"));
    base.hasContributing = names.some((n) => n.startsWith("contributing"));

    // Detect CI
    const hasGithubDir = names.includes(".github");
    if (hasGithubDir) {
      base.hasCI = true;
      base.ciSystem = "GitHub Actions";
    } else if (names.includes(".travis.yml")) {
      base.hasCI = true;
      base.ciSystem = "Travis CI";
    } else if (names.includes(".circleci")) {
      base.hasCI = true;
      base.ciSystem = "CircleCI";
    } else if (names.includes("jenkinsfile")) {
      base.hasCI = true;
      base.ciSystem = "Jenkins";
    }

    // Detect test framework from package files
    const hasCargo = names.includes("cargo.toml");
    const hasPytest = names.some((n) => n.includes("pytest") || n === "pyproject.toml");
    const hasJest = names.includes("jest.config.js") || names.includes("jest.config.ts");
    const hasVitest = names.includes("vitest.config.ts") || names.includes("vitest.config.js");

    if (hasCargo) base.testFramework = "cargo test";
    else if (hasPytest) base.testFramework = "pytest";
    else if (hasJest) base.testFramework = "Jest";
    else if (hasVitest) base.testFramework = "Vitest";
    else if (base.hasTests) base.testFramework = "unknown";
  } catch { /* return base */ }

  return base;
}

// ─── Niche Commit Analysis ────────────────────────────────────────────────────
// The CORE signal: how much have they actually committed in the specific niche?
// Uses GitHub code search to find repos where they've made niche-specific contributions.

export async function analyzeNicheCommits(
  username: string,
  nicheKeywords: string[],   // e.g. ["transformer", "attention", "tokenizer"]
  repos: GitHubRepo[]
): Promise<NicheCommitAnalysis> {
  const nicheRepos: string[] = [];
  const samples: CommitSample[] = [];
  let totalNicheCommits = 0;
  let recentNicheCommits = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  // Step 1: Identify which repos are niche-relevant
  // Match on: repo name, description, topics, language
  const nicheRelevantRepos = repos.filter((repo) => {
    const haystack = [
      repo.name,
      repo.description ?? "",
      (repo.topics ?? []).join(" "),
    ].join(" ").toLowerCase();

    return nicheKeywords.some((kw) => haystack.includes(kw.toLowerCase()));
  });

  // Step 2: For niche repos, get commits from this author
  await Promise.allSettled(
    nicheRelevantRepos.slice(0, 5).map(async (repo) => {
      try {
        const [owner, repoName] = repo.full_name.split("/");
        const { data: commits } = await octokit.repos.listCommits({
          owner,
          repo: repoName,
          author: username,
          per_page: 30,
        });

        if (commits.length > 0) {
          nicheRepos.push(repo.full_name);
          totalNicheCommits += commits.length;

          const recent = commits.filter((c) => {
            const date = c.commit.author?.date;
            return date && new Date(date) > oneYearAgo;
          });
          recentNicheCommits += recent.length;

          // Track date range
          const dates = commits
            .map((c) => c.commit.author?.date)
            .filter(Boolean) as string[];
          if (dates.length > 0) {
            const oldest = dates[dates.length - 1];
            const newest = dates[0];
            if (!firstDate || oldest < firstDate) firstDate = oldest;
            if (!lastDate || newest > lastDate) lastDate = newest;
          }

          // Collect commit message samples (the most revealing signal)
          for (const commit of commits.slice(0, 5)) {
            const message = commit.commit.message;
            samples.push({
              sha: commit.sha.slice(0, 8),
              message: message.split("\n")[0].trim(),
              messageBody: message.split("\n").slice(1).join("\n").trim().slice(0, 300),
              repo: repo.name,
              date: commit.commit.author?.date ?? "",
              additions: 0,
              deletions: 0,
              filesChanged: 0,
              diffSnippet: null,
            });
          }
        }
      } catch { /* continue */ }
    })
  );

  // Step 3: If no repo-level matches, try GitHub code search
  // This finds files they've committed to that CONTAIN the niche keywords
  if (nicheRepos.length === 0 && nicheKeywords.length > 0) {
    try {
      const codeQuery = `user:${username} ${nicheKeywords.slice(0, 2).join(" OR ")}`;
      const { data: codeResults } = await octokit.search.code({
        q: codeQuery,
        per_page: 5,
      });

      for (const result of codeResults.items) {
        const repoFullName = result.repository.full_name;
        if (!nicheRepos.includes(repoFullName)) {
          nicheRepos.push(repoFullName);
          totalNicheCommits += 1; // Proxy: found a niche file
        }
      }
    } catch { /* code search has stricter rate limits */ }
  }

  return {
    totalNicheCommits,
    recentNicheCommits,
    nicheRepos,
    samples: samples.slice(0, 15),
    firstNicheCommitDate: firstDate,
    lastNicheCommitDate: lastDate,
  };
}

// ─── Contribution Graph (weekly stats) ───────────────────────────────────────

export async function getContributionSignals(
  username: string,
  repos: GitHubRepo[]
): Promise<DeepGitHubData["contributionSignals"]> {
  try {
    // Use stats/commit_activity for their top repo as proxy
    const topRepo = repos.find((r) => !r.is_fork && r.size > 10);
    if (!topRepo) return { activeWeeksLast6Months: 0, longestStreak: 0, averageWeeklyCommits: 0 };

    const [owner, repoName] = topRepo.full_name.split("/");
    const { data: activity } = await octokit.repos.getCommitActivityStats({
      owner,
      repo: repoName,
    });

    if (!Array.isArray(activity)) return { activeWeeksLast6Months: 0, longestStreak: 0, averageWeeklyCommits: 0 };

    const last26Weeks = activity.slice(-26); // ~6 months
    const activeWeeks = last26Weeks.filter((w) => w.total > 0).length;
    const avgCommits =
      last26Weeks.reduce((a, w) => a + w.total, 0) / Math.max(last26Weeks.length, 1);

    // Compute longest streak
    let longestStreak = 0;
    let currentStreak = 0;
    for (const week of activity) {
      if (week.total > 0) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    return {
      activeWeeksLast6Months: activeWeeks,
      longestStreak,
      averageWeeklyCommits: Math.round(avgCommits * 10) / 10,
    };
  } catch {
    return { activeWeeksLast6Months: 0, longestStreak: 0, averageWeeklyCommits: 0 };
  }
}
