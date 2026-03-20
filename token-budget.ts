/**
 * TOKEN BUDGET MANAGER
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks estimated token consumption across all LLM calls and enforces
 * per-session and per-operation spending limits.
 *
 * Why this matters:
 *   - Anthropic bills per token. A runaway loop or missing cache can burn
 *     an entire $5 credit in minutes.
 *   - Rate limits are per-minute token budgets. Exceeding them = 429 errors.
 *   - "Costs will catch me off guard" is preventable with a budget layer.
 *
 * Design:
 *   - In-process singleton (no Redis needed for per-session tracking)
 *   - Conservative token estimation (overcount by 20% to avoid surprises)
 *   - Per-operation-type limits (analysis is expensive; query rewrite is cheap)
 *   - Graceful degradation: hit limit → use compressed prompts or skip
 *   - Hard stop: approaching absolute limit → refuse further calls
 *
 * Token estimation method:
 *   Anthropic models: ~4 chars per token (GPT family standard, good enough)
 *   We add 20% safety margin on top.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type OperationType =
  | "query_analyze"        // cheap: ~800 tokens in, ~400 out
  | "profile_synthesize"   // expensive: ~3000 tokens in, ~1500 out
  | "niche_fit"            // medium: ~2000 tokens in, ~1000 out
  | "code_quality"         // medium: ~2500 tokens in, ~600 out
  | "ranking_narrative"    // medium: ~2000 tokens in, ~800 out
  | "bias_audit"           // cheap: ~500 tokens in, ~200 out
  | "bot_verify"           // cheap: ~300 tokens in, ~100 out
  | "unknown";

export interface TokenUsage {
  operation: OperationType;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  /** Estimated cost in USD cents */
  estimatedCostCents: number;
  timestamp: number;
  cacheHit: boolean;
}

export interface BudgetStatus {
  sessionTokensUsed: number;
  sessionTokensBudget: number;
  sessionCostCentsUsed: number;
  sessionCostCentsBudget: number;
  minuteTokensUsed: number;
  minuteTokensBudget: number;
  isHardBlocked: boolean;
  isSoftWarning: boolean;
  remainingPercent: number;
}

// ─── Cost Constants ───────────────────────────────────────────────────────────
// Anthropic Claude Sonnet 4 pricing (as of early 2025, cents per 1k tokens)
// Using conservative estimates — actual prices may differ

const COST_PER_1K_INPUT_CENTS = 0.3;       // $3 / 1M input tokens
const COST_PER_1K_OUTPUT_CENTS = 1.5;      // $15 / 1M output tokens
const COST_PER_1K_CACHED_INPUT_CENTS = 0.03; // 10x cheaper with prompt caching

// ─── Per-Operation Budgets ────────────────────────────────────────────────────
// Maximum tokens for each operation type. Exceeding = use fallback.

const OP_TOKEN_LIMITS: Record<OperationType, { input: number; output: number }> = {
  query_analyze:        { input: 1200,  output: 600  },
  profile_synthesize:   { input: 4000,  output: 2500 },
  niche_fit:            { input: 2500,  output: 1500 },
  code_quality:         { input: 3500,  output: 1000 },
  ranking_narrative:    { input: 2500,  output: 1200 },
  bias_audit:           { input: 800,   output: 300  },
  bot_verify:           { input: 500,   output: 150  },
  unknown:              { input: 2000,  output: 1000 },
};

// ─── Session Budget ───────────────────────────────────────────────────────────

const SESSION_TOKEN_BUDGET = 200_000;     // ~$0.06 per session for inputs at Sonnet rates
const SESSION_COST_BUDGET_CENTS = 50;    // $0.50 hard cap per session
const MINUTE_TOKEN_BUDGET = 40_000;      // Stay within Anthropic's rate limits
const SOFT_WARNING_PERCENT = 0.75;       // Warn when 75% used
const HARD_BLOCK_PERCENT = 0.95;         // Block new calls at 95%

// ─── Singleton State ──────────────────────────────────────────────────────────
// In-process only — resets on server restart (intentional: budget is per-session)

let sessionTokensUsed = 0;
let sessionCostCentsUsed = 0;
const minuteWindow: Array<{ tokens: number; ts: number }> = [];
const usageLog: TokenUsage[] = [];

// ─── Token Estimator ──────────────────────────────────────────────────────────
// ~4 chars per token + 20% safety margin

function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.2);
}

function estimateCost(inputTokens: number, outputTokens: number, cachedInput = 0): number {
  const freshInput = inputTokens - cachedInput;
  return (
    (freshInput / 1000) * COST_PER_1K_INPUT_CENTS +
    (cachedInput / 1000) * COST_PER_1K_CACHED_INPUT_CENTS +
    (outputTokens / 1000) * COST_PER_1K_OUTPUT_CENTS
  );
}

// ─── Minute Window ────────────────────────────────────────────────────────────

function getMinuteTokensUsed(): number {
  const now = Date.now();
  const cutoff = now - 60_000;
  // Evict old entries
  while (minuteWindow.length > 0 && minuteWindow[0].ts < cutoff) {
    minuteWindow.shift();
  }
  return minuteWindow.reduce((sum, e) => sum + e.tokens, 0);
}

// ─── Main Budget API ──────────────────────────────────────────────────────────

export const tokenBudget = {
  /**
   * checkBefore — call before making an LLM API call.
   * Returns whether to proceed, and if not, why.
   */
  checkBefore(
    prompt: string,
    operation: OperationType,
    maxTokens: number
  ): { allowed: boolean; reason: string | null; compressPrompt: boolean } {
    const estimatedInput = estimateTokens(prompt);
    const totalEstimated = estimatedInput + maxTokens;

    const minuteUsed = getMinuteTokensUsed();
    const sessionRemaining = SESSION_TOKEN_BUDGET - sessionTokensUsed;
    const minuteRemaining = MINUTE_TOKEN_BUDGET - minuteUsed;
    const costRemaining = SESSION_COST_BUDGET_CENTS - sessionCostCentsUsed;

    // Hard block: session budget exhausted
    if (sessionTokensUsed / SESSION_TOKEN_BUDGET >= HARD_BLOCK_PERCENT) {
      return { allowed: false, reason: `Session token budget exhausted (${sessionTokensUsed}/${SESSION_TOKEN_BUDGET})`, compressPrompt: false };
    }

    // Hard block: cost limit
    if (sessionCostCentsUsed >= SESSION_COST_BUDGET_CENTS) {
      return { allowed: false, reason: `Session cost limit reached ($${(sessionCostCentsUsed / 100).toFixed(2)})`, compressPrompt: false };
    }

    // Soft compress: approaching limit but not there
    const compressPrompt =
      (sessionTokensUsed / SESSION_TOKEN_BUDGET >= SOFT_WARNING_PERCENT) ||
      (minuteUsed / MINUTE_TOKEN_BUDGET >= SOFT_WARNING_PERCENT);

    // Rate limit: minute window
    if (totalEstimated > minuteRemaining) {
      return { allowed: false, reason: `Minute rate limit: ${minuteUsed}/${MINUTE_TOKEN_BUDGET} tokens used`, compressPrompt: false };
    }

    // Per-operation limit
    const opLimit = OP_TOKEN_LIMITS[operation];
    if (estimatedInput > opLimit.input * 1.5) {
      // Prompt is way over budget for this op — compress
      return { allowed: true, reason: null, compressPrompt: true };
    }

    return { allowed: true, reason: null, compressPrompt };
  },

  /**
   * recordUsage — call after a successful LLM response.
   */
  recordUsage(
    operation: OperationType,
    actualInputTokens: number,
    actualOutputTokens: number,
    cacheHit: boolean,
    cachedInputTokens = 0
  ): void {
    const total = actualInputTokens + actualOutputTokens;
    const costCents = estimateCost(actualInputTokens, actualOutputTokens, cachedInputTokens);

    sessionTokensUsed += total;
    sessionCostCentsUsed += costCents;
    minuteWindow.push({ tokens: total, ts: Date.now() });

    const entry: TokenUsage = {
      operation,
      estimatedInputTokens: actualInputTokens,
      estimatedOutputTokens: actualOutputTokens,
      estimatedTotalTokens: total,
      estimatedCostCents: costCents,
      timestamp: Date.now(),
      cacheHit,
    };
    usageLog.push(entry);

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[Budget] ${operation}: ${actualInputTokens}in + ${actualOutputTokens}out = ${total} tokens` +
        ` (~$${(costCents / 100).toFixed(4)})` +
        ` | Session: ${sessionTokensUsed}/${SESSION_TOKEN_BUDGET}` +
        (cacheHit ? " [CACHE HIT]" : "")
      );
    }
  },

  /**
   * getStatus — returns current budget usage for monitoring/UI display.
   */
  getStatus(): BudgetStatus {
    const minuteUsed = getMinuteTokensUsed();
    const sessionRemaining = SESSION_TOKEN_BUDGET - sessionTokensUsed;
    return {
      sessionTokensUsed,
      sessionTokensBudget: SESSION_TOKEN_BUDGET,
      sessionCostCentsUsed,
      sessionCostCentsBudget: SESSION_COST_BUDGET_CENTS,
      minuteTokensUsed: minuteUsed,
      minuteTokensBudget: MINUTE_TOKEN_BUDGET,
      isHardBlocked: sessionTokensUsed / SESSION_TOKEN_BUDGET >= HARD_BLOCK_PERCENT,
      isSoftWarning: sessionTokensUsed / SESSION_TOKEN_BUDGET >= SOFT_WARNING_PERCENT,
      remainingPercent: Math.max(0, (sessionRemaining / SESSION_TOKEN_BUDGET) * 100),
    };
  },

  /**
   * getUsageLog — returns all recorded calls for audit/display.
   */
  getUsageLog(): TokenUsage[] {
    return [...usageLog];
  },

  /**
   * reset — resets session counters (for testing).
   */
  reset(): void {
    sessionTokensUsed = 0;
    sessionCostCentsUsed = 0;
    minuteWindow.length = 0;
    usageLog.length = 0;
  },

  /**
   * compressPrompt — trims a prompt to fit within the operation's input budget.
   * Preserves the beginning (instructions) and end (the actual question).
   */
  compressPrompt(prompt: string, operation: OperationType): string {
    const limit = OP_TOKEN_LIMITS[operation].input;
    const charLimit = limit * 4; // rough char equivalent
    if (prompt.length <= charLimit) return prompt;

    // Keep first 40% (system instructions) + last 40% (actual data/question)
    const keep = Math.floor(charLimit * 0.4);
    return (
      prompt.slice(0, keep) +
      "\n\n[... middle section compressed for token budget ...]\n\n" +
      prompt.slice(-keep)
    );
  },
};

// ─── Exported Estimate Helper ─────────────────────────────────────────────────

export function estimateCallTokens(prompt: string, maxOutputTokens: number): number {
  return estimateTokens(prompt) + maxOutputTokens;
}
