/**
 * lib/github.js — GitHub REST API client
 *
 * Rate limits:
 *   Unauthenticated: 60 requests / hour
 *   With GITHUB_TOKEN: 5,000 requests / hour
 *
 * To increase limit: add NEXT_PUBLIC_GITHUB_TOKEN to .env.local
 * Get token at: GitHub → Settings → Developer settings → Personal access tokens → Classic
 * Required scopes: none (all public data)
 */

const GITHUB_BASE = "https://api.github.com"

function getHeaders() {
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN
  return {
    Accept: "application/vnd.github.v3+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * Core fetch with retry + rate-limit awareness
 */
async function ghFetch(path, retries = 1) {
  const url = `${GITHUB_BASE}${path}`
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: getHeaders(), next: { revalidate: 300 } })

    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining")
      if (remaining === "0") {
        const resetAt = res.headers.get("x-ratelimit-reset")
        const waitMs = resetAt ? (parseInt(resetAt) * 1000 - Date.now()) : 60_000
        throw new RateLimitError(`GitHub rate limit exceeded. Resets in ${Math.ceil(waitMs / 60000)} min. Add NEXT_PUBLIC_GITHUB_TOKEN for 5,000 req/hr.`)
      }
      throw new Error(`GitHub 403: ${path}`)
    }

    if (res.status === 404) {
      throw new NotFoundError(`Not found: ${path}`)
    }

    if (res.status === 422) {
      throw new Error(`GitHub validation error: ${path}`)
    }

    if (!res.ok) {
      lastError = new Error(`GitHub ${res.status}: ${path}`)
      if (attempt < retries) {
        await sleep(800 * (attempt + 1))
        continue
      }
      throw lastError
    }

    return res.json()
  }

  throw lastError
}

/**
 * Search users by query string (GitHub search syntax)
 * Returns up to `perPage` users
 */
export async function searchUsers(query, perPage = 12) {
  const encoded = encodeURIComponent(query)
  const data = await ghFetch(`/search/users?q=${encoded}&per_page=${perPage}&sort=followers`)
  return data.items ?? []
}

/**
 * Full user profile
 */
export async function getUser(username) {
  return ghFetch(`/users/${username}`)
}

/**
 * Top repos sorted by stars
 */
export async function getUserRepos(username, count = 8) {
  return ghFetch(`/users/${username}/repos?sort=stars&per_page=${count}`)
}

/**
 * Raw README text (truncated to maxChars)
 * Returns empty string if no README exists
 */
export async function getReadme(owner, repo, maxChars = 2000) {
  try {
    const res = await fetch(`${GITHUB_BASE}/repos/${owner}/${repo}/readme`, {
      headers: { ...getHeaders(), Accept: "application/vnd.github.raw" },
    })
    if (!res.ok) return ""
    const text = await res.text()
    return text.slice(0, maxChars)
  } catch {
    return ""
  }
}

/**
 * Fetch user + repos + READMEs in parallel
 */
export async function fetchFullProfile(username) {
  const [user, repos] = await Promise.all([
    getUser(username),
    getUserRepos(username, 8),
  ])

  // Fetch READMEs for top 3 repos in parallel (best-effort)
  const readmeResults = await Promise.allSettled(
    repos.slice(0, 3).map((r) => getReadme(username, r.name))
  )
  const readmes = readmeResults.map((r) => (r.status === "fulfilled" ? r.value : ""))

  return { user, repos, readmes }
}

// ─── Custom Errors ─────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = "RateLimitError" }
}

export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = "NotFoundError" }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
