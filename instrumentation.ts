/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Pre-loads all-MiniLM-L6-v2 so the first search request doesn't
 * pay the ~2s model-load cold start penalty.
 *
 * Place this file at the project root: /instrumentation.ts
 * Next.js picks it up automatically (Next 15+).
 */
export async function register() {
  // Only run in Node.js runtime (not edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmEmbeddingModel } = await import("@/lib/embeddings/client");
    await warmEmbeddingModel();
  }
}
