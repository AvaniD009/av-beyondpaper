/**
 * REQUEST COALESCER
 * ─────────────────────────────────────────────────────────────────────────────
 * Deduplicates concurrent in-flight LLM requests with identical prompts.
 *
 * Problem (thundering herd):
 *   When the cache is cold (e.g. first deploy, or after cache expiry),
 *   10 concurrent requests for the same profile analysis all miss the cache
 *   and all try to call the API simultaneously.
 *
 *   Result: 10× the cost, 10× the rate limit consumption, API hammering.
 *
 * Solution:
 *   When request A starts and is in-flight, requests B–J with the same
 *   prompt hash wait on A's promise instead of spawning their own.
 *   When A resolves, all 10 get the same response simultaneously.
 *   Only 1 API call made for 10 concurrent requests.
 *
 * This is standard in HTTP proxies (cache stampede prevention) and
 * databases (connection pooling with query deduplication).
 *
 * Usage:
 *   const result = await coalescer.execute(promptHash, () => callClaude(prompt));
 */

// ─── Coalescer ────────────────────────────────────────────────────────────────

type PendingRequest<T> = {
  promise: Promise<T>;
  startedAt: number;
  callerCount: number;
};

class RequestCoalescer {
  private inflight = new Map<string, PendingRequest<string>>();

  /**
   * execute — runs fn() if no in-flight request exists for key,
   * otherwise waits for the existing request.
   *
   * @param key     - Unique key for deduplication (typically the prompt hash)
   * @param fn      - The async function to coalesce (must return a string)
   * @param timeout - Max ms to wait before falling through to a fresh call
   */
  async execute(
    key: string,
    fn: () => Promise<string>,
    timeout = 30_000
  ): Promise<string> {
    // If there's already an in-flight request for this key, join it
    const existing = this.inflight.get(key);
    if (existing) {
      existing.callerCount++;
      const elapsed = Date.now() - existing.startedAt;

      if (elapsed < timeout) {
        console.log(
          `[Coalescer] Joining in-flight request (key=${key.slice(0, 12)}…, ` +
          `callers=${existing.callerCount}, elapsed=${elapsed}ms)`
        );
        return existing.promise;
      }
      // Existing request has been going too long — fall through to fresh call
      console.warn(`[Coalescer] In-flight request timed out (${elapsed}ms) — making fresh call`);
    }

    // Start a new request and register it
    const promise = fn().finally(() => {
      // Clean up when the request completes (success or failure)
      this.inflight.delete(key);
    });

    this.inflight.set(key, {
      promise,
      startedAt: Date.now(),
      callerCount: 1,
    });

    return promise;
  }

  /**
   * size — number of currently in-flight requests.
   */
  get size(): number {
    return this.inflight.size;
  }

  /**
   * clear — force-clears all in-flight requests (for testing).
   */
  clear(): void {
    this.inflight.clear();
  }
}

export const coalescer = new RequestCoalescer();
