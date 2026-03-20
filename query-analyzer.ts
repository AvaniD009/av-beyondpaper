import { callClaude, callClaudeJSON } from "@/lib/claude/client";
import {
  sanitizeInput,
  assertSafeToProcess,
  type SanitizedInput,
} from "./input-sanitizer";

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface QueryRewrite {
  /** The original input, preserved verbatim */
  originalInput: string;
  /** One-line explanation of what was understood from the raw input */
  interpretedAs: string;
  /** The fully rewritten expert-level query string — shown in the UI as the "upgraded" query */
  expertQuery: string;
  /** If the input was gibberish/too vague, this explains what was inferred */
  inferenceNote: string | null;
  /** How confident the rewrite is: high | medium | low */
  confidence: "high" | "medium" | "low";
}

export interface QueryAnalysis {
  /** Sanitization result from Stage 0 — for audit/debug and UI feedback */
  sanitized: SanitizedInput;
  /** Rewrite metadata — always present, shown in UI */
  rewrite: QueryRewrite;
  /** What the recruiter is actually looking for (one sentence) */
  intent: string;
  /** 3-5 concise GitHub search API queries — short, keyword-dense */
  githubSearchTerms: string[];
  /** 8-15 lowercase keywords for DB full-text search */
  dbKeywords: string[];
  /** 2-4 specific engineering domains inferred */
  domains: string[];
  /** Explicit + strongly implied required skills */
  requiredSkills: string[];
  /** Adjacent / bonus skills that would signal a stronger fit */
  bonusSignals: string[];
  /** Programming languages relevant to the search */
  languages: string[];
  /** Seniority signal: intern | junior | mid | senior | staff | any */
  seniority: "intern" | "junior" | "mid" | "senior" | "staff" | "any";
  /** Whether the query implies a niche/uncommon specialty */
  isNiche: boolean;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const REWRITE_SYSTEM = `You are a bridge between human intuition and technical precision.

Your job is a two-part transformation:

PART 1 — UNDERSTAND INTENT
No matter how mangled, vague, abbreviation-heavy, typo-ridden, or half-formed the input is, extract the TRUE engineering need hidden inside it. People often type queries the way they think, not the way search engines understand. You translate thought → intent.

PART 2 — REWRITE TO EXPERT PRECISION  
Rewrite the query as if a Principal Engineer at a top-tier company wrote it after fully understanding the need. Your rewrite should:
- Use correct, precise technical terminology (no buzzwords, no vague adjectives)
- Name actual tools, frameworks, algorithms, or architectural patterns relevant to the domain
- Imply the real depth level required (ML research vs ML engineering vs MLOps are very different)
- Be specific enough to narrow to the right sub-discipline within a broad field
- Read like something a technical recruiter with 10 years of specialized experience would say

You handle: typos, abbreviations, partial thoughts, non-English fragments, domain slang, overly broad inputs, and completely blank/nonsense inputs.

NEVER refuse or say "I don't understand". Always produce your best interpretation with an appropriate confidence level.`;

const ANALYSIS_SYSTEM = `You are an expert GitHub talent intelligence system.

You receive an already-rewritten, expert-level engineering search query and decompose it into machine-actionable signals.

You understand:
- How GitHub search ranking works and what queries surface the right profiles
- The difference between surface-level skills (listed in bio) vs demonstrated expertise (found in repos)
- Which technical domains have hidden talent pools vs well-known ones
- How to detect implied skills from domain context (e.g. "Kubernetes operator" implies Go + controller-runtime + CRD design)

Your decomposition must be precise, exhaustive in keywords, and calibrated for finding people — not documents.`;

// ─── Stage 1: Gibberish → Expert Query ───────────────────────────────────────

/**
 * Stage 1 of Agent 1.
 *
 * Takes ANY user input — including gibberish, slang, abbreviations, half-sentences,
 * domain jargon, typos, or multi-language fragments — and produces:
 *   a) what was understood
 *   b) a fully expert-level rewritten query
 *   c) a confidence rating
 *
 * This is the "translation layer" before any search logic runs.
 */
async function rewriteQuery(rawInput: string): Promise<QueryRewrite> {
  // Sanitize: collapse whitespace, trim
  const sanitized = rawInput.trim().replace(/\s+/g, " ").slice(0, 500);

  const prompt = `The user typed this into a GitHub engineer search engine:

INPUT: "${sanitized}"

Rewrite this into a precise expert-level engineering search query.

Return JSON with this exact shape:
{
  "originalInput": "${sanitized.replace(/"/g, '\\"')}",
  "interpretedAs": "one sentence: what technical need this represents (be specific)",
  "expertQuery": "the fully rewritten expert query — use proper technical terminology, name actual tools/frameworks/patterns, imply depth level. 1-3 sentences max.",
  "inferenceNote": "if significant guesswork was needed, explain what was inferred and why — otherwise null",
  "confidence": "high if input was clear | medium if some inference was needed | low if significant guesswork"
}

EXAMPLES of how to transform inputs:

Input: "rust guy who knows low level stuff"
→ expertQuery: "Systems engineer with deep Rust expertise in low-level domains: memory allocators, async runtimes, FFI boundaries, or embedded systems. Demonstrated through published crates or contributions to core ecosystem projects."
→ confidence: "medium"

Input: "ml infra not research vibes"
→ expertQuery: "ML infrastructure engineer focused on production systems: model serving, training pipeline optimization, distributed training orchestration (Ray, DeepSpeed), or feature store design. Not research — real deployment at scale."
→ confidence: "high"

Input: "wasm bro"
→ expertQuery: "Engineer with hands-on WebAssembly expertise: WASM runtimes (Wasmtime, wasmer), component model, WASI, or compiling non-JS languages to WASM targets. Likely active in the Bytecode Alliance ecosystem."
→ confidence: "medium"

Input: "k8s stuff"
→ expertQuery: "Kubernetes platform engineer or operator developer. Look for: custom controllers/operators (controller-runtime, kubebuilder), cluster API, admission webhooks, multi-tenancy patterns, or significant contributions to CNCF projects."
→ confidence: "high"

Input: "guy who does the database things with postgres"
→ expertQuery: "PostgreSQL expert demonstrating depth beyond basic usage: extension development (C/Rust), query planner internals, replication topologies, partitioning strategies, or contributions to pg ecosystem tooling."
→ confidence: "medium"

Input: "asdfjkl"
→ expertQuery: "Unable to determine intent. Interpreting as a general software engineering search."
→ confidence: "low"
→ inferenceNote: "Input was not recognizable as a technical query. Defaulting to general search."`;

  const raw = await callClaudeJSON<QueryRewrite>(prompt, {
    system: REWRITE_SYSTEM,
    maxTokens: 512,
  });

  return raw;
}

// ─── Stage 2: Expert Query → Search Signals ──────────────────────────────────

/**
 * Stage 2 of Agent 1.
 *
 * Takes the expert-rewritten query and decomposes it into every signal
 * the downstream discovery and ranking agents need.
 */
async function decomposeQuery(rewrite: QueryRewrite & { _structureHints?: SanitizedInput["structure"] }): Promise<Omit<QueryAnalysis, "rewrite" | "sanitized">> {
  const hints = rewrite._structureHints;
  const hintBlock = hints
    ? `\nPRE-EXTRACTED SIGNALS (trust these — already extracted from raw input):
${hints.detectedLanguages.length ? `- Languages: ${hints.detectedLanguages.join(", ")}` : ""}
${hints.detectedToolNames.length ? `- Tools detected: ${hints.detectedToolNames.join(", ")}` : ""}
${hints.detectedSeniority ? `- Seniority signal: ${hints.detectedSeniority}` : ""}
`.trim()
    : "";
  const prompt = `Decompose this expert engineering search query into structured search signals.

QUERY: "${rewrite.expertQuery}"
INTERPRETED AS: "${rewrite.interpretedAs}"
${hintBlock}

Return JSON with this exact shape:
{
  "intent": "what the recruiter truly needs — one specific sentence, no hedging",

  "githubSearchTerms": [
    "3-5 distinct search queries for GitHub user search API",
    "Each 2-5 words, keyword-dense, technical",
    "Cover different angles: tools, patterns, project types",
    "NO full sentences — just keyword clusters"
  ],

  "dbKeywords": [
    "8-15 lowercase keywords for full-text search",
    "include: tool names, framework names, acronyms, architectural patterns",
    "include synonyms and alternate spellings",
    "include adjacent concepts that co-occur with this expertise"
  ],

  "domains": [
    "2-4 specific engineering sub-domains",
    "Be precise: 'distributed consensus algorithms' not 'backend'",
    "Examples: 'WebAssembly runtimes', 'ML model quantization', 'kernel networking'"
  ],

  "requiredSkills": [
    "6-12 skills that are required or very strongly implied",
    "Mix: explicit mentions + skills that ALWAYS co-occur in this domain",
    "Include tool names, language names, protocol names, design patterns"
  ],

  "bonusSignals": [
    "4-8 adjacent skills that would make a candidate even stronger",
    "These are signals of depth, not breadth — what experts in this area also tend to know"
  ],

  "languages": ["programming languages central to this domain, or [] if language-agnostic"],

  "seniority": "intern|junior|mid|senior|staff|any — infer from query context",

  "isNiche": true/false — true if this is a specialized sub-discipline most engineers haven't touched
}

QUALITY BAR for githubSearchTerms:
✓ "wasm runtime wasmtime" 
✓ "kernel networking ebpf xdp"
✓ "postgres extension C replication"
✗ "find engineers who know postgres" — too verbose
✗ "database" — too broad`;

  return callClaudeJSON<Omit<QueryAnalysis, "rewrite">>(prompt, {
    system: ANALYSIS_SYSTEM,
    maxTokens: 1500,
  });
}

// ─── Main Export: Two-Stage Query Analyzer ───────────────────────────────────

/**
 * Agent 1 — Full two-stage query intelligence pipeline.
 *
 * Stage 0: Sanitize
 *   Prompt injection defense, truncation, structural cleanup
 *   → throws immediately if input is blocked or empty
 *
 * Stage 1: Rewrite
 *   ANY input → expert-level query
 *   Handles: gibberish, slang, abbreviations, typos, vagueness, multi-language
 *
 * Stage 2: Decompose
 *   Expert query → machine-actionable search signals
 *   Produces: GitHub search terms, DB keywords, domains, skills, seniority
 *
 * Both stages run sequentially (S2 depends on S1 output).
 * S1 result is preserved and surfaced to the UI as the "query upgrade" card.
 *
 * Risks mitigated:
 * - Garbage-in → expert rewrite prevents garbage downstream
 * - Single-query brittleness → 3-5 multi-angle GitHub search terms
 * - Keyword mismatch → synonyms + co-occurring terms in dbKeywords
 * - Wrong depth level → seniority + isNiche signals calibrate ranking
 */
export async function analyzeQuery(rawInput: string): Promise<QueryAnalysis> {
  // ── Stage 0: Sanitize ─────────────────────────────────────────────────────
  // Must run first. Blocks injections, truncates, normalizes, classifies.
  // assertSafeToProcess() throws with a structured ApiError if not safe.
  const sanitized = await sanitizeInput(rawInput);
  assertSafeToProcess(sanitized);

  // From here on, only `sanitized.clean` is used — never the raw input.
  // If the structure extractor found a GitHub username, that's routed separately
  // by the caller (profile lookup path, not search path).

  // ── Stage 1: Rewrite ──────────────────────────────────────────────────────
  // Use clean input — injection-free, truncated, normalized
  const rewrite = await rewriteQuery(sanitized.clean);

  // ── Stage 2: Decompose ────────────────────────────────────────────────────
  // Seed with extracted structure so Claude doesn't re-infer what we already know
  const seededRewrite = {
    ...rewrite,
    // If sanitizer already found languages/tools, hint to decomposer
    _structureHints: sanitized.structure,
  };
  const signals = await decomposeQuery(seededRewrite);

  // Merge: sanitizer-detected languages take precedence (they're exact matches)
  const mergedLanguages = [
    ...new Set([
      ...sanitized.structure.detectedLanguages,
      ...signals.languages,
    ]),
  ];

  // Merge seniority: prefer what sanitizer found in raw text (exact token match)
  const mergedSeniority =
    (sanitized.structure.detectedSeniority as QueryAnalysis["seniority"]) ??
    signals.seniority;

  return {
    sanitized,
    rewrite,
    ...signals,
    languages: mergedLanguages,
    seniority: mergedSeniority,
  };
}

// ─── Utility: Display-ready rewrite summary ───────────────────────────────────

/**
 * Returns a human-readable string describing how the query was upgraded.
 * Used in the UI "query understood as..." card.
 */
export function formatQueryUpgrade(analysis: QueryAnalysis): {
  wasRewritten: boolean;
  displayText: string;
  confidenceLabel: string;
} {
  const { rewrite } = analysis;
  const normalized = rewrite.originalInput.trim().toLowerCase();
  const expertNorm = rewrite.expertQuery.trim().toLowerCase();

  // Consider it rewritten if the expert query is substantially different
  const wasRewritten =
    rewrite.confidence !== "high" ||
    Math.abs(expertNorm.length - normalized.length) > 20 ||
    !expertNorm.startsWith(normalized.slice(0, 10));

  const confidenceLabel =
    rewrite.confidence === "high"
      ? "Query understood clearly"
      : rewrite.confidence === "medium"
      ? "Query interpreted with some inference"
      : "Query was vague — best-effort interpretation";

  return {
    wasRewritten,
    displayText: rewrite.expertQuery,
    confidenceLabel,
  };
}
