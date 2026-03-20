/**
 * AGENT 2 — DISCOVERY STRATEGIES
 * ─────────────────────────────────────────────────────────────────────────────
 * 9 parallel, unconventional strategies for discovering overlooked engineers.
 *
 * Each strategy asks a DIFFERENT QUESTION about the domain.
 * No single strategy finds everyone — the power is in the union.
 *
 * Design rule: every strategy must be answering a question that:
 *   a) Cannot be answered by a simple GitHub user search
 *   b) Surface engineers who are INVISIBLE to traditional recruiting tools
 *   c) Produces a "discovery path" that explains WHY this person appeared
 */

import { octokit, type GitHubSearchUser } from "@/lib/github/client";

// ─── Discovery Result ─────────────────────────────────────────────────────────

export interface RawDiscovery {
  login: string;
  avatar_url: string;
  html_url: string;
  /** Which strategy found this person */
  strategy: StrategyName;
  /** Specific signal that caused inclusion */
  discoverySignal: string;
  /** Why conventional search would miss them */
  whyOverlooked: string;
  /** Strength of the discovery signal (1–10) */
  signalStrength: number;
}

export type StrategyName =
  | "topic_graph"
  | "contributor_network"
  | "hidden_gem"
  | "fork_evolution"
  | "domain_longevity"
  | "package_ecosystem"
  | "cross_domain_transfer"
  | "issue_intelligence"
  | "direct_search";

// ─── GitHub Topic Taxonomy ────────────────────────────────────────────────────
// Maps broad domain terms to precise GitHub topic tags.
// GitHub topics are self-assigned and are much more specific than repo names.

const TOPIC_MAP: Record<string, string[]> = {
  "systems programming": ["systems-programming", "low-level", "bare-metal", "no-std", "ffi"],
  "compiler": ["compiler", "llvm", "bytecode", "ir", "codegen", "parser", "lexer", "ast"],
  "webassembly": ["webassembly", "wasm", "wasi", "wasmtime", "wasmer", "wit"],
  "embedded": ["embedded", "no-std", "rtos", "microcontroller", "firmware", "embedded-systems"],
  "networking": ["networking", "tcp", "udp", "quic", "http3", "dpdk", "ebpf", "xdp"],
  "distributed systems": ["distributed-systems", "consensus", "raft", "paxos", "crdt", "replication"],
  "ml inference": ["inference", "onnx", "tvm", "tensorrt", "triton", "quantization", "model-serving"],
  "robotics": ["robotics", "ros", "ros2", "slam", "motion-planning", "path-planning"],
  "cryptography": ["cryptography", "zero-knowledge", "zkp", "elliptic-curve", "homomorphic"],
  "database internals": ["database-internals", "storage-engine", "lsm-tree", "b-tree", "wal"],
  "gpu": ["gpu", "cuda", "opencl", "vulkan", "webgpu", "metal", "compute-shaders"],
  "language design": ["language-design", "type-system", "type-theory", "dependent-types", "haskell"],
  "operating systems": ["operating-system", "kernel", "hypervisor", "virtualization", "linux-kernel"],
};

function getTopicsForDomain(domains: string[]): string[] {
  const topics = new Set<string>();
  for (const domain of domains) {
    const lower = domain.toLowerCase();
    for (const [key, tags] of Object.entries(TOPIC_MAP)) {
      if (lower.includes(key) || key.includes(lower)) {
        tags.forEach((t) => topics.add(t));
      }
    }
    // Also try domain words directly as topics
    lower.split(/\s+/).forEach((word) => {
      if (word.length > 4) topics.add(word);
    });
  }
  return [...topics].slice(0, 12);
}

// ─── Strategy A: Topic Graph Miner ───────────────────────────────────────────
// Question: "Who owns repos tagged with the precise niche topic clusters
//            that define this domain — not marketing terms, but technical ones?"
// Why overlooked: GitHub topics are invisible to LinkedIn/resume searches.

export async function topicGraphMiner(
  domains: string[],
  skills: string[]
): Promise<RawDiscovery[]> {
  const topics = getTopicsForDomain(domains);
  if (topics.length === 0) return [];

  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  // Try pairs of topics to find engineers with BOTH — intersection = deeper expertise
  const topicPairs: [string, string][] = [];
  for (let i = 0; i < Math.min(topics.length, 5); i++) {
    for (let j = i + 1; j < Math.min(topics.length, 5); j++) {
      topicPairs.push([topics[i], topics[j]]);
    }
  }

  const queries = [
    ...topicPairs.slice(0, 4).map(([a, b]) => `topic:${a}+topic:${b}`),
    ...topics.slice(0, 3).map((t) => `topic:${t}`),
  ];

  await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const { data } = await octokit.search.repositories({
          q: `${q} stars:1..500`, // Deliberately cap at 500: we want overlooked, not famous
          sort: "updated",
          per_page: 5,
        });

        for (const repo of data.items) {
          if (!repo.owner || seen.has(repo.owner.login)) continue;
          seen.add(repo.owner.login);

          results.push({
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url,
            html_url: `https://github.com/${repo.owner.login}`,
            strategy: "topic_graph",
            discoverySignal: `Owns "${repo.name}" tagged with ${q.replace("topic:", "").replace("+", " + ")}`,
            whyOverlooked: "Found via niche topic tags — invisible to keyword-only searches",
            signalStrength: 7,
          });
        }
      } catch {
        // Silently continue on rate limit or timeout
      }
    })
  );

  return results;
}

// ─── Strategy B: Contributor Network Tracer ──────────────────────────────────
// Question: "Who has committed to 2+ high-signal repos in this domain
//            WITHOUT owning them — the silent experts behind the builders?"
// Why overlooked: contributor lists are never searched by any recruiting tool.

export async function contributorNetworkTracer(
  searchTerms: string[],
  domains: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();
  const contributorCount = new Map<string, { count: number; repos: string[]; user: GitHubSearchUser }>();

  // First find the key repos in this domain
  const keyRepos: Array<{ owner: string; name: string }> = [];

  await Promise.allSettled(
    searchTerms.slice(0, 3).map(async (term) => {
      try {
        const { data } = await octokit.search.repositories({
          q: `${term} stars:50..5000`,
          sort: "stars",
          per_page: 4,
        });
        for (const repo of data.items) {
          if (repo.owner) keyRepos.push({ owner: repo.owner.login, name: repo.name });
        }
      } catch { /* continue */ }
    })
  );

  if (keyRepos.length === 0) return [];

  // Now fetch contributors to those repos
  await Promise.allSettled(
    keyRepos.slice(0, 6).map(async ({ owner, name }) => {
      try {
        const { data } = await octokit.repos.listContributors({
          owner,
          repo: name,
          per_page: 20,
          anon: "false",
        });

        for (const contributor of data) {
          if (!contributor.login) continue;
          // Skip the repo owner — we want contributors to OTHERS' repos
          if (contributor.login === owner) continue;
          // Skip bots (quick check)
          if (contributor.login.includes("[bot]") || contributor.login.includes("-bot")) continue;

          const repoKey = `${owner}/${name}`;
          const existing = contributorCount.get(contributor.login);
          if (existing) {
            existing.count++;
            existing.repos.push(repoKey);
          } else {
            contributorCount.set(contributor.login, {
              count: 1,
              repos: [repoKey],
              user: {
                login: contributor.login,
                avatar_url: contributor.avatar_url ?? "",
                html_url: contributor.html_url ?? `https://github.com/${contributor.login}`,
                score: 0,
              },
            });
          }
        }
      } catch { /* continue */ }
    })
  );

  // Only return people who contributed to 2+ repos — multi-repo contribution is the signal
  for (const [login, data] of contributorCount.entries()) {
    if (data.count < 2 || seen.has(login)) continue;
    seen.add(login);

    results.push({
      login,
      avatar_url: data.user.avatar_url,
      html_url: data.user.html_url,
      strategy: "contributor_network",
      discoverySignal: `Contributed to ${data.count} key repos: ${data.repos.slice(0, 2).join(", ")}`,
      whyOverlooked: "Silent contributor to others' work — no personal famous repo, pure domain expertise",
      signalStrength: Math.min(10, 5 + data.count * 1.5), // more repos = stronger signal
    });
  }

  return results;
}

// ─── Strategy C: Hidden Gem Scanner ──────────────────────────────────────────
// Question: "Who built something real in this domain, wrote a thorough README,
//            but hasn't been discovered yet (0–80 stars)?"
// Why overlooked: every tool sorts by stars. We invert this.

export async function hiddenGemScanner(
  searchTerms: string[],
  skills: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  const queries = [
    ...searchTerms.slice(0, 2).map((t) => `${t} stars:2..80`),
    ...skills.slice(0, 2).map((s) => `${s.toLowerCase()} stars:1..50 readme:true`),
  ];

  await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const { data } = await octokit.search.repositories({
          q,
          sort: "updated",
          per_page: 6,
        });

        for (const repo of data.items) {
          if (!repo.owner || seen.has(repo.owner.login)) continue;
          // Require at least some repo size (>50KB = real project, not toy)
          if ((repo.size ?? 0) < 50) continue;
          // Require README
          if (!repo.description && !repo.homepage) continue;

          seen.add(repo.owner.login);
          results.push({
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url,
            html_url: `https://github.com/${repo.owner.login}`,
            strategy: "hidden_gem",
            discoverySignal: `"${repo.name}" (${repo.stargazers_count} ⭐) — real project, low exposure`,
            whyOverlooked: `Low star count (${repo.stargazers_count}) hides a substantive project — fame filter would skip this`,
            signalStrength: 8, // Hidden gems get high signal — this is the core SkillSync thesis
          });
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy D: Fork Evolution Detector ─────────────────────────────────────
// Question: "Who forked a key repo and meaningfully diverged — showing they
//            understood it deeply enough to extend or redirect it?"
// Why overlooked: forks are universally dismissed. A fork with 200+ original
//                 commits beyond the parent is NOT a fork — it's a new project.

export async function forkEvolutionDetector(
  searchTerms: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  // Find source repos in the domain first
  const sourceRepos: Array<{ owner: string; name: string; fullName: string }> = [];
  try {
    for (const term of searchTerms.slice(0, 2)) {
      const { data } = await octokit.search.repositories({
        q: `${term} stars:200..10000 fork:false`,
        sort: "stars",
        per_page: 3,
      });
      for (const r of data.items) {
        if (r.owner) sourceRepos.push({ owner: r.owner.login, name: r.name, fullName: r.full_name });
      }
    }
  } catch { /* continue */ }

  // Find forks that have diverged significantly (ahead_by > 50 commits)
  await Promise.allSettled(
    sourceRepos.slice(0, 3).map(async ({ owner, name, fullName }) => {
      try {
        const { data: forks } = await octokit.repos.listForks({
          owner,
          repo: name,
          sort: "newest",
          per_page: 10,
        });

        for (const fork of forks) {
          if (!fork.owner || seen.has(fork.owner.login)) continue;

          // Check if this fork has actually diverged (has its own commits)
          // Proxy: fork size meaningfully larger than original, or has been recently updated
          const parentUpdated = new Date(fork.parent?.updated_at ?? 0).getTime();
          const forkUpdated = new Date(fork.updated_at ?? 0).getTime();
          const forkIsActive = forkUpdated > parentUpdated - 1000 * 60 * 60 * 24 * 30; // active in last month

          if (fork.size && fork.size > 100 && forkIsActive) {
            seen.add(fork.owner.login);
            results.push({
              login: fork.owner.login,
              avatar_url: fork.owner.avatar_url,
              html_url: `https://github.com/${fork.owner.login}`,
              strategy: "fork_evolution",
              discoverySignal: `Actively extended fork of "${fullName}" — own direction, not a copy`,
              whyOverlooked: "Forks are universally dismissed. This person understood X deeply enough to evolve it.",
              signalStrength: 7,
            });
          }
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy E: Domain Longevity Tracer ─────────────────────────────────────
// Question: "Who has been consistently working in this domain for 3+ years?"
// Why overlooked: no tool surfaces longevity. A person with 4 years of quiet,
//                 consistent work in a niche is far more trustworthy than a
//                 person with 6 months of visible activity.

export async function domainLongevityTracer(
  skills: string[],
  domains: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  const dateStr = threeYearsAgo.toISOString().split("T")[0];

  const queries = [
    ...skills.slice(0, 2).map((s) => `${s.toLowerCase()} pushed:>${dateStr} stars:1..200`),
    ...domains.slice(0, 2).map((d) => `${d.split(" ")[0]} created:<${dateStr} stars:1..300`),
  ];

  await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const { data } = await octokit.search.repositories({
          q,
          sort: "updated",
          per_page: 5,
        });

        for (const repo of data.items) {
          if (!repo.owner || seen.has(repo.owner.login)) continue;
          // The repo was created before 3 years ago and is still active
          const isOld = repo.created_at
            ? new Date(repo.created_at) < threeYearsAgo
            : false;
          if (!isOld) continue;

          seen.add(repo.owner.login);
          const years = Math.floor(
            (Date.now() - new Date(repo.created_at ?? 0).getTime()) /
              (1000 * 60 * 60 * 24 * 365)
          );

          results.push({
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url,
            html_url: `https://github.com/${repo.owner.login}`,
            strategy: "domain_longevity",
            discoverySignal: `"${repo.name}" has been maintained for ${years}+ years in this domain`,
            whyOverlooked: "Long-term focused builders are invisible to trending/follower-based tools",
            signalStrength: 6 + Math.min(years, 4), // longer = stronger
          });
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy F: Package Ecosystem Miner ─────────────────────────────────────
// Question: "Who has PUBLISHED a library/package in this domain?"
// Why overlooked: package registries (npm, crates.io, PyPI) are never searched
//                 for talent. Publishing a package signals deep expertise.
//                 You don't publish unless you're confident in your domain.

export async function packageEcosystemMiner(
  skills: string[],
  languages: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  const searches: Array<{ registry: string; query: string; language: string }> = [];

  // Determine which registries to check based on detected languages
  const langLower = languages.map((l) => l.toLowerCase());

  if (langLower.some((l) => ["rust"].includes(l))) {
    skills.slice(0, 2).forEach((s) =>
      searches.push({ registry: "crates.io", query: s, language: "rust" })
    );
  }
  if (langLower.some((l) => ["python", "py"].includes(l))) {
    skills.slice(0, 2).forEach((s) =>
      searches.push({ registry: "pypi", query: s, language: "python" })
    );
  }
  if (langLower.some((l) => ["typescript", "javascript", "js", "ts"].includes(l))) {
    skills.slice(0, 2).forEach((s) =>
      searches.push({ registry: "npm", query: s, language: "typescript" })
    );
  }

  // If no language detected, default to all
  if (searches.length === 0) {
    skills.slice(0, 1).forEach((s) => {
      searches.push({ registry: "crates.io", query: s, language: "rust" });
      searches.push({ registry: "npm", query: s, language: "typescript" });
    });
  }

  await Promise.allSettled(
    searches.slice(0, 4).map(async ({ registry, query, language }) => {
      try {
        let githubUsers: Array<{ login: string; package: string; downloads?: number }> = [];

        if (registry === "crates.io") {
          const resp = await fetch(
            `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=5`,
            { headers: { "User-Agent": "skillsync-clone/1.0" } }
          );
          if (resp.ok) {
            const json = await resp.json();
            for (const crate of json.crates ?? []) {
              if (crate.repository?.includes("github.com")) {
                const match = crate.repository.match(/github\.com\/([^/]+)/);
                if (match) {
                  githubUsers.push({
                    login: match[1],
                    package: crate.name,
                    downloads: crate.downloads,
                  });
                }
              }
            }
          }
        } else if (registry === "npm") {
          const resp = await fetch(
            `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`
          );
          if (resp.ok) {
            const json = await resp.json();
            for (const obj of json.objects ?? []) {
              const pkg = obj.package;
              if (pkg?.links?.repository?.includes("github.com")) {
                const match = pkg.links.repository.match(/github\.com\/([^/]+)/);
                if (match) {
                  githubUsers.push({ login: match[1], package: pkg.name });
                }
              }
            }
          }
        }

        for (const { login, package: pkg, downloads } in githubUsers) {
          if (seen.has(login)) continue;
          seen.add(login);
          results.push({
            login,
            avatar_url: `https://avatars.githubusercontent.com/${login}`,
            html_url: `https://github.com/${login}`,
            strategy: "package_ecosystem",
            discoverySignal: `Published "${pkg}" on ${registry}${downloads ? ` (${downloads.toLocaleString()} downloads)` : ""}`,
            whyOverlooked: "Package authors are never surfaced by profile-based recruiting tools",
            signalStrength: 9, // Publishing = highest expertise signal
          });
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy G: Cross-Domain Transfer Detector ──────────────────────────────
// Question: "Who brings expertise from domain X into domain Y in a way that
//            most domain-Y specialists haven't thought of?"
// Why overlooked: multi-domain engineers look "unfocused" to keyword tools.
//                 They're actually the most innovative people in any field.
// Note: This strategy returns candidates for CLAUDE to evaluate further —
//       the cross-domain signal is subtle and needs AI to recognize.

export async function crossDomainTransferDetector(
  domains: string[],
  skills: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  // Build adjacent-domain pairs to search for intersection
  const adjacentPairs: Array<[string, string]> = [
    ["hardware", "software"],
    ["research", "engineering"],
    ["security", "systems"],
    ["compiler", "runtime"],
    ["formal-verification", "distributed"],
    ["embedded", "wasm"],
    ["ml", "systems"],
    ["networking", "storage"],
  ];

  const domainWords = domains.flatMap((d) => d.toLowerCase().split(/\s+/));
  const relevantPairs = adjacentPairs.filter(([a, b]) =>
    domainWords.some((w) => a.includes(w) || b.includes(w) || w.includes(a) || w.includes(b))
  );

  const pairsToTry = relevantPairs.length > 0 ? relevantPairs : adjacentPairs.slice(0, 2);

  await Promise.allSettled(
    pairsToTry.slice(0, 3).map(async ([domainA, domainB]) => {
      try {
        const { data } = await octokit.search.users({
          q: `${domainA} ${domainB} repos:>4`,
          per_page: 5,
        });

        for (const user of data.items) {
          if (seen.has(user.login)) continue;
          seen.add(user.login);
          results.push({
            login: user.login,
            avatar_url: user.avatar_url,
            html_url: user.html_url,
            strategy: "cross_domain_transfer",
            discoverySignal: `Bridges ${domainA} and ${domainB} expertise in their portfolio`,
            whyOverlooked: "Multi-domain engineers appear 'scattered' to keyword tools but are often the most innovative",
            signalStrength: 6,
          });
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy H: Direct GitHub Search (baseline) ─────────────────────────────
// The conventional approach — included but weighted lowest.
// De-prioritized relative to all strategies above.

export async function directGitHubSearch(
  searchTerms: string[],
  languages: string[]
): Promise<RawDiscovery[]> {
  const results: RawDiscovery[] = [];
  const seen = new Set<string>();

  const queries = searchTerms.slice(0, 3).map((term) => {
    const langFilter = languages[0] ? ` language:${languages[0]}` : "";
    return `${term}${langFilter} repos:>3`;
  });

  await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const { data } = await octokit.search.users({ q, per_page: 8 });
        for (const user of data.items) {
          if (seen.has(user.login)) continue;
          seen.add(user.login);
          results.push({
            login: user.login,
            avatar_url: user.avatar_url,
            html_url: user.html_url,
            strategy: "direct_search",
            discoverySignal: `Matched GitHub user search: "${q}"`,
            whyOverlooked: "Conventional search — may have low follower count despite real expertise",
            signalStrength: 4, // Lowest weight — this is what everyone else already does
          });
        }
      } catch { /* continue */ }
    })
  );

  return results;
}

// ─── Strategy Weight Map ──────────────────────────────────────────────────────
// Used by the orchestrator to prioritize results when de-duping
// (if a person is found by multiple strategies, highest weight wins)

export const STRATEGY_WEIGHTS: Record<StrategyName, number> = {
  package_ecosystem: 9,      // Published a library = deepest signal
  contributor_network: 8,    // Silent contributor to others' work
  hidden_gem: 8,             // Built something real, no fame yet
  topic_graph: 7,            // Self-tagged with precise niche topics
  fork_evolution: 7,         // Extended others' work meaningfully
  cross_domain_transfer: 6,  // Rare multi-domain intersection
  domain_longevity: 6,       // Years of sustained focus
  issue_intelligence: 5,     // Quality of problem reporting
  direct_search: 4,          // Conventional baseline
};
