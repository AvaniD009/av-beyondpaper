/**
 * CIRCUIT BREAKER
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements Nygard's circuit breaker pattern from "Release It!" (2007).
 *
 * Problem it solves:
 *   When Anthropic's API is down or rate-limited, naive retry logic makes
 *   things worse: every retry waits, blocks threads, and wastes tokens.
 *   A 3-attempt retry with exponential backoff = 14 seconds of blocking
 *   per call × N concurrent calls = system grinds to a halt.
 *
 * Solution:
 *   Track failures. After N failures in a time window, "trip" the breaker —
 *   fail fast with a local error instead of attempting the API.
 *   After a cooldown period, allow one probe request to test recovery.
 *
 * States:
 *   CLOSED   → Normal operation. Failures counted.
 *   OPEN     → Tripped. All calls fail immediately. No API contact.
 *   HALF_OPEN → Cooldown elapsed. One probe request allowed.
 *              If probe succeeds → CLOSED.
 *              If probe fails    → OPEN (reset cooldown).
 *
 * Configuration tuned for Anthropic API behavior:
 *   - Trips after 5 failures in 60 seconds
 *   - Cooldown: 30 seconds before trying again
 *   - Half-open: 1 probe request to verify recovery
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitStats {
  state: CircuitState;
  failures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
  totalCalls: number;
  totalFailures: number;
  totalFastFails: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const FAILURE_THRESHOLD = 5;          // Trip after this many failures
const FAILURE_WINDOW_MS = 60_000;     // ...within this time window (1 minute)
const COOLDOWN_MS = 30_000;           // Wait this long before probing (30 seconds)
const HALF_OPEN_MAX_CALLS = 1;        // Only allow 1 probe in half-open state

// ─── Circuit Breaker Class ────────────────────────────────────────────────────

class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures: Array<number> = []; // timestamps of recent failures
  private halfOpenCalls = 0;
  private stats: CircuitStats = {
    state: "CLOSED",
    failures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    totalCalls: 0,
    totalFailures: 0,
    totalFastFails: 0,
  };

  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * canCall — checks whether a call is allowed given the current circuit state.
   * Returns false if the circuit is OPEN and cooldown hasn't elapsed.
   */
  canCall(): boolean {
    this.stats.totalCalls++;

    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.stats.openedAt ?? 0);
      if (elapsed >= COOLDOWN_MS) {
        // Transition to half-open: allow one probe
        this.state = "HALF_OPEN";
        this.halfOpenCalls = 0;
        this.stats.state = "HALF_OPEN";
        console.log(`[Circuit:${this.name}] → HALF_OPEN (probing recovery)`);
        return true;
      }
      // Still open — fast fail
      this.stats.totalFastFails++;
      return false;
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenCalls < HALF_OPEN_MAX_CALLS) {
        this.halfOpenCalls++;
        return true;
      }
      // Already have a probe in flight — fast fail
      this.stats.totalFastFails++;
      return false;
    }

    return true;
  }

  /**
   * recordSuccess — call after a successful API response.
   */
  recordSuccess(): void {
    this.stats.lastSuccessAt = Date.now();

    if (this.state === "HALF_OPEN") {
      // Probe succeeded — reset and close
      this.state = "CLOSED";
      this.failures = [];
      this.halfOpenCalls = 0;
      this.stats.state = "CLOSED";
      this.stats.failures = 0;
      console.log(`[Circuit:${this.name}] → CLOSED (recovered)`);
      return;
    }

    // Remove old failures outside window
    this.pruneOldFailures();
  }

  /**
   * recordFailure — call after an API error. May trip the breaker.
   */
  recordFailure(err: unknown): void {
    const now = Date.now();
    this.stats.totalFailures++;
    this.stats.lastFailureAt = now;

    if (this.state === "HALF_OPEN") {
      // Probe failed — back to open
      this.state = "OPEN";
      this.stats.state = "OPEN";
      this.stats.openedAt = now;
      console.warn(`[Circuit:${this.name}] → OPEN (probe failed: ${err})`);
      return;
    }

    this.failures.push(now);
    this.pruneOldFailures();
    this.stats.failures = this.failures.length;

    if (this.failures.length >= FAILURE_THRESHOLD) {
      this.state = "OPEN";
      this.stats.state = "OPEN";
      this.stats.openedAt = now;
      console.error(
        `[Circuit:${this.name}] → OPEN (${this.failures.length} failures in ${FAILURE_WINDOW_MS / 1000}s) — cooling down ${COOLDOWN_MS / 1000}s`
      );
    }
  }

  private pruneOldFailures(): void {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((ts) => ts > cutoff);
    this.stats.failures = this.failures.length;
  }

  getStats(): Readonly<CircuitStats> {
    return { ...this.stats };
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Force reset — for testing */
  reset(): void {
    this.state = "CLOSED";
    this.failures = [];
    this.halfOpenCalls = 0;
    this.stats = {
      state: "CLOSED", failures: 0, lastFailureAt: null, lastSuccessAt: null,
      openedAt: null, totalCalls: 0, totalFailures: 0, totalFastFails: 0,
    };
  }
}

// ─── Singleton Breaker ─────────────────────────────────────────────────────────
// One breaker for the Anthropic API (could be per-endpoint if needed)

export const anthropicBreaker = new CircuitBreaker("anthropic");

/**
 * CircuitOpenError — thrown when the circuit is open.
 * Callers should catch this separately from API errors and either
 * return a cached fallback or surface a "service degraded" message.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker OPEN for ${name} — failing fast to protect the system`);
    this.name = "CircuitOpenError";
  }
}
