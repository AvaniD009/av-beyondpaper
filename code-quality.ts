/**
 * CODE QUALITY EVALUATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Evaluates actual code quality from sampled repository files.
 *
 * Approach: sample a few real code files from key repos and evaluate against
 * objective engineering standards. This is NOT about style preferences —
 * it's about craft signals that correlate with expertise:
 *
 *   - Error handling completeness (do they handle edge cases?)
 *   - Abstraction quality (do they name things clearly?)
 *   - Documentation within code (do they explain WHY, not just WHAT?)
 *   - Complexity management (do they decompose problems?)
 *   - Testing patterns (do they test the hard parts?)
 *   - Dependency hygiene (do they reach for quality libraries?)
 *   - Niche-specific patterns (do they use domain-correct idioms?)
 */

import { octokit } from "./client";
import { callClaudeJSON } from "@/lib/claude/client";
import { BIAS_FREE_SYSTEM_PROMPT } from "@/lib/agents/bias-free-evaluator";
import type { GitHubRepo } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodeFileSample {
  repo: string;
  path: string;
  language: string;
  content: string;     // First 2000 chars
  size: number;        // Total file size
}

export interface CodeQualityDimension {
  dimension: string;
  rating: "exemplary" | "solid" | "adequate" | "developing";
  evidence: string;    // Specific line/pattern that demonstrates this
  score: number;       // 1–10
}

export interface CodeQualityReport {
  /** Overall craft score — depth-weighted average */
  overallScore: number;
  /** Per-dimension scores */
  dimensions: CodeQualityDimension[];
  /** Files sampled for this evaluation */
  sampledFiles: string[];
  /** Niche-specific idiom compliance */
  nicheIdiomScore: number;
  /** Whether they write production-grade code */
  isProductionGrade: boolean;
  /** Domain-specific patterns detected */
  domainPatternsFound: string[];
  /** Red flags (if any) */
  redFlags: string[];
  /** Green flags that show craft */
  greenFlags: string[];
}

// ─── File Sampler ─────────────────────────────────────────────────────────────
// Intelligently picks files that are most revealing about code quality.
// Avoids: generated files, test fixtures, lock files, auto-generated code.

const SKIP_EXTENSIONS = new Set([
  "lock", "json", "toml", "yaml", "yml", "md", "txt", "png", "jpg", "svg",
  "ico", "woff", "woff2", "ttf", "eot", "min.js", "min.css", "d.ts",
]);

const SKIP_PATTERNS = [
  /^\./, // hidden files
  /generated/i,
  /auto[-_]?gen/i,
  /node_modules/i,
  /dist\//i,
  /build\//i,
  /vendor\//i,
  /__pycache__/i,
  /migrations\//i,
  /\.pb\.go$/, // protobuf generated
  /\.gen\./,   // generated
];

function isRevealingFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (SKIP_PATTERNS.some((p) => p.test(path))) return false;

  // Prefer: main source files, core modules, lib/ directories
  const preferred = [
    /^src\//,
    /^lib\//,
    /^core\//,
    /^pkg\//,
    /^crates?\//,
    /main\.(rs|go|py|ts|cpp|c)$/,
    /lib\.(rs|go|py|ts)$/,
    /mod\.rs$/,
    /index\.(ts|js|py)$/,
  ];

  // Strongly prefer core implementation files
  if (preferred.some((p) => p.test(path))) return true;

  // Accept other source files
  const sourceExts = new Set(["rs", "go", "py", "ts", "tsx", "cpp", "c", "java", "kt", "swift", "zig", "ex", "exs", "ml", "hs"]);
  return sourceExts.has(ext);
}

async function sampleCodeFiles(
  repos: GitHubRepo[],
  username: string,
  maxFiles = 5
): Promise<CodeFileSample[]> {
  const samples: CodeFileSample[] = [];
  const topRepos = repos.filter((r) => !r.is_fork && r.size > 20).slice(0, 3);

  for (const repo of topRepos) {
    if (samples.length >= maxFiles) break;
    const [owner, repoName] = repo.full_name.split("/");

    try {
      // Get file tree
      const { data: tree } = await octokit.git.getTree({
        owner,
        repo: repoName,
        tree_sha: "HEAD",
        recursive: "1",
      });

      // Filter and rank files
      const candidates = (tree.tree ?? [])
        .filter((f) => f.type === "blob" && f.path && isRevealingFile(f.path))
        .sort((a, b) => {
          // Prefer src/ and lib/ files
          const aScore = (a.path?.includes("src/") || a.path?.includes("lib/")) ? 1 : 0;
          const bScore = (b.path?.includes("src/") || b.path?.includes("lib/")) ? 1 : 0;
          return bScore - aScore;
        })
        .slice(0, 3);

      for (const file of candidates) {
        if (!file.path || !file.sha || samples.length >= maxFiles) break;

        try {
          const { data: blob } = await octokit.git.getBlob({
            owner,
            repo: repoName,
            file_sha: file.sha,
          });

          if (blob.encoding === "base64") {
            const content = Buffer.from(blob.content, "base64").toString("utf-8");
            // Skip if content is clearly generated
            if (content.includes("DO NOT EDIT") || content.includes("@generated")) continue;

            const ext = file.path.split(".").pop() ?? "";
            samples.push({
              repo: repo.name,
              path: file.path,
              language: repo.language ?? ext,
              content: content.slice(0, 2500),
              size: content.length,
            });
          }
        } catch { /* skip file */ }
      }
    } catch { /* skip repo */ }
  }

  return samples;
}

// ─── Quality Dimensions ───────────────────────────────────────────────────────

// Niche-specific idioms: what patterns should appear in code from this domain?
const NICHE_IDIOM_MAP: Record<string, { patterns: RegExp[]; description: string }[]> = {
  nlp: [
    { patterns: [/tokenize|tokenizer|BPE|wordpiece/i], description: "Proper tokenization handling" },
    { patterns: [/attention_mask|padding|truncation/i], description: "Sequence padding awareness" },
    { patterns: [/embedding|vocab_size|hidden_size/i], description: "Transformer architecture patterns" },
  ],
  "machine learning": [
    { patterns: [/\.backward\(\)|optimizer\.step\(\)/i], description: "Training loop patterns" },
    { patterns: [/train_loader|DataLoader|dataset/i], description: "Dataset handling" },
    { patterns: [/\.eval\(\)|with torch\.no_grad/i], description: "Eval mode discipline" },
  ],
  "systems programming": [
    { patterns: [/unsafe\s*\{|#\[unsafe\]/i, /malloc|free|ptr::/i], description: "Explicit memory management" },
    { patterns: [/Arc<|Rc<|Mutex<|RwLock</i], description: "Concurrency safety patterns" },
    { patterns: [/#\[repr\(|#\[derive\(/i], description: "Rust/C ABI discipline" },
  ],
  "distributed systems": [
    { patterns: [/retry|backoff|circuit.?breaker/i], description: "Resilience patterns" },
    { patterns: [/consensus|quorum|leader.election/i], description: "Distributed consensus" },
    { patterns: [/idempotent|exactly.once|at.least.once/i], description: "Delivery semantics" },
  ],
  compiler: [
    { patterns: [/AST|abstract.syntax|parse_tree/i], description: "AST manipulation" },
    { patterns: [/visitor.pattern|walk|traverse/i], description: "Tree traversal patterns" },
    { patterns: [/emit|codegen|instruction/i], description: "Code generation" },
  ],
  networking: [
    { patterns: [/socket|bind|listen|accept/i], description: "Socket programming" },
    { patterns: [/epoll|kqueue|io_uring|async/i], description: "Async I/O patterns" },
    { patterns: [/packet|frame|header|checksum/i], description: "Protocol-level thinking" },
  ],
};

function getNicheIdioms(domains: string[]): Array<{ patterns: RegExp[]; description: string }> {
  const idioms: Array<{ patterns: RegExp[]; description: string }> = [];
  for (const domain of domains) {
    const lower = domain.toLowerCase();
    for (const [key, keyIdioms] of Object.entries(NICHE_IDIOM_MAP)) {
      if (lower.includes(key) || key.includes(lower.split(" ")[0])) {
        idioms.push(...keyIdioms);
      }
    }
  }
  return idioms;
}

// ─── Claude Code Quality Analysis ────────────────────────────────────────────

async function runCodeQualityAnalysis(
  samples: CodeFileSample[],
  domains: string[],
  requiredSkills: string[]
): Promise<CodeQualityReport> {
  if (samples.length === 0) {
    return {
      overallScore: 0,
      dimensions: [],
      sampledFiles: [],
      nicheIdiomScore: 0,
      isProductionGrade: false,
      domainPatternsFound: [],
      redFlags: ["No code files could be sampled"],
      greenFlags: [],
    };
  }

  const codeSections = samples
    .map(
      (s, i) => `### File ${i + 1}: ${s.repo}/${s.path} (${s.language})
\`\`\`
${s.content}
\`\`\``
    )
    .join("\n\n");

  const nicheIdioms = getNicheIdioms(domains);
  const idiomChecklist = nicheIdioms.length > 0
    ? `\nDomain-specific patterns to check for (${domains.join(", ")}):\n` +
      nicheIdioms.map((i) => `- ${i.description}`).join("\n")
    : "";

  const result = await callClaudeJSON<{
    overallScore: number;
    dimensions: CodeQualityDimension[];
    nicheIdiomScore: number;
    isProductionGrade: boolean;
    domainPatternsFound: string[];
    redFlags: string[];
    greenFlags: string[];
  }>(
    `Evaluate the code quality and engineering standards of these code samples.
Focus on CRAFT and DEPTH signals — not stylistic preferences.
This engineer works in: ${domains.join(", ")}
Required skills to verify: ${requiredSkills.join(", ")}
${idiomChecklist}

CODE SAMPLES:
${codeSections}

Evaluate these dimensions:
1. Error handling completeness — do they handle edge cases and failure modes?
2. Abstraction quality — are names clear and do they decompose problems well?
3. Documentation quality — do comments explain WHY, not just WHAT?
4. Complexity management — is the code structured to be maintainable?
5. Niche expertise idioms — do they use domain-correct patterns and primitives?
6. Production-readiness signals — is this the kind of code you'd ship?

Return JSON:
{
  "overallScore": <1-10>,
  "dimensions": [
    {
      "dimension": "error_handling|abstraction|documentation|complexity|niche_idioms|production_readiness",
      "rating": "exemplary|solid|adequate|developing",
      "evidence": "specific line or pattern from the code that justifies this rating",
      "score": <1-10>
    }
  ],
  "nicheIdiomScore": <1-10, how well they use domain-specific patterns>,
  "isProductionGrade": <true|false>,
  "domainPatternsFound": ["list of specific domain patterns you found in the code"],
  "redFlags": ["concerning patterns if any — empty array if none"],
  "greenFlags": ["impressive craft signals — specific things that show expertise"]
}`,
    {
      system: BIAS_FREE_SYSTEM_PROMPT,
      maxTokens: 1500,
    }
  );

  return {
    ...result,
    sampledFiles: samples.map((s) => `${s.repo}/${s.path}`),
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function evaluateCodeQuality(
  repos: GitHubRepo[],
  username: string,
  domains: string[],
  requiredSkills: string[]
): Promise<CodeQualityReport> {
  const samples = await sampleCodeFiles(repos, username);
  return runCodeQualityAnalysis(samples, domains, requiredSkills);
}
