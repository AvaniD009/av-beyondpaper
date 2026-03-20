/**
 * /api/claude — Server-side Claude proxy
 * Keeps ANTHROPIC_API_KEY off the browser.
 * Accepts: POST { system: string, user: string }
 * Returns: { result: object } | { error: string }
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const MODEL = "claude-sonnet-4-20250514"
const MAX_RETRIES = 2

export async function POST(request) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { system, user } = body
  if (!user) return Response.json({ error: "Missing user prompt" }, { status: 400 })

  let lastError = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1000,
          system: system || "You are a helpful assistant. Return ONLY valid JSON, no markdown.",
          messages: [{ role: "user", content: user }],
        }),
      })

      if (res.status === 429) {
        // Rate limited — wait and retry
        const wait = (attempt + 1) * 2000
        await new Promise((r) => setTimeout(r, wait))
        continue
      }

      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Anthropic ${res.status}: ${err}`)
      }

      const data = await res.json()
      const rawText = data.content?.find((b) => b.type === "text")?.text ?? "{}"

      // Strip markdown fences if Claude wrapped JSON in backticks
      const cleaned = rawText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim()

      let result
      try {
        result = JSON.parse(cleaned)
      } catch {
        // Return as plain text if not JSON
        result = { text: rawText }
      }

      return Response.json({ result })
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }

  console.error("[/api/claude] Failed after retries:", lastError)
  return Response.json({ error: lastError?.message ?? "Unknown error" }, { status: 502 })
}
