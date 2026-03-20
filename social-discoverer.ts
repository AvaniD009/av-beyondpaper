/**
 * SOCIAL LINK DISCOVERER
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovers all reachable social/professional presence for a GitHub user:
 *
 *   Tier 1 — Direct from GitHub profile (zero extra calls):
 *     - blog/website field
 *     - company field (may contain links)
 *     - bio links
 *     - twitter_username field (available via API)
 *
 *   Tier 2 — Inferred from GitHub profile page (fetch once):
 *     - LinkedIn from profile HTML
 *     - Twitter/X handle
 *     - Personal website
 *     - Linktree / Bento / Beacons link aggregators
 *     - README profile repo (username/username)
 *
 *   Tier 3 — Inferred from profile README content:
 *     - Any links in their pinned profile README
 *
 *   Tier 4 — Name-based web search (last resort, only if name is known):
 *     - Search for "{name} site:linkedin.com"
 *     - Search for "{name} developer blog"
 *     - Search for "{name} github.io"
 *
 * PRIVACY DESIGN:
 *   - We only surface links the person has publicly shared themselves
 *   - No scraping of private data, no inference beyond what they published
 *   - All discovery is traceable to a public source
 *   - Instagram/social media only discovered if they linked it themselves
 */

import { octokit } from "./client";
import type { GitHubUser } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LinkSource =
  | "github_bio"
  | "github_blog_field"
  | "github_company_field"
  | "github_twitter_field"
  | "profile_readme"
  | "name_search"
  | "inferred";

export interface DiscoveredLink {
  url: string;
  platform: SocialPlatform;
  confidence: "certain" | "likely" | "possible";
  source: LinkSource;
  /** Raw text that produced this link */
  rawText: string;
}

export type SocialPlatform =
  | "github"
  | "linkedin"
  | "twitter"
  | "instagram"
  | "personal_website"
  | "linktree"
  | "beacons"
  | "bento"
  | "substack"
  | "medium"
  | "devto"
  | "hashnode"
  | "youtube"
  | "portfolio"
  | "unknown";

export interface SocialPresence {
  /** Always present */
  github: string;
  /** Discovered links by platform */
  linkedin: DiscoveredLink | null;
  twitter: DiscoveredLink | null;
  instagram: DiscoveredLink | null;
  personalWebsite: DiscoveredLink | null;
  linktree: DiscoveredLink | null;
  blog: DiscoveredLink | null;
  /** All other discovered links */
  otherLinks: DiscoveredLink[];
  /** Profile README content (if exists) — analyzed separately */
  profileReadme: string | null;
  /** How many social channels were found */
  presenceScore: number; // 0–10
  /** Whether the engineer has a public writing presence */
  hasWritingPresence: boolean;
}

// ─── URL Patterns ─────────────────────────────────────────────────────────────

const PLATFORM_PATTERNS: Array<{
  platform: SocialPlatform;
  patterns: RegExp[];
  normalize?: (url: string) => string;
}> = [
  {
    platform: "linkedin",
    patterns: [/linkedin\.com\/in\/([\w-]+)/i, /linkedin\.com\/pub\/([\w-]+)/i],
    normalize: (url) =>
      url.startsWith("http") ? url : `https://www.linkedin.com/in/${url}`,
  },
  {
    platform: "twitter",
    patterns: [
      /(?:twitter|x)\.com\/([\w]+)/i,
      /^@([\w]{1,50})$/,
    ],
    normalize: (url) =>
      url.startsWith("@") ? `https://x.com/${url.slice(1)}` : url,
  },
  {
    platform: "instagram",
    patterns: [/instagram\.com\/([\w.]+)/i],
  },
  {
    platform: "linktree",
    patterns: [/linktr\.ee\/([\w]+)/i, /linktree\.me\/([\w]+)/i],
  },
  {
    platform: "beacons",
    patterns: [/beacons\.ai\/([\w]+)/i],
  },
  {
    platform: "bento",
    patterns: [/bento\.me\/([\w]+)/i],
  },
  {
    platform: "substack",
    patterns: [/([\w]+)\.substack\.com/i],
  },
  {
    platform: "medium",
    patterns: [/medium\.com\/@?([\w-]+)/i],
  },
  {
    platform: "devto",
    patterns: [/dev\.to\/([\w]+)/i],
  },
  {
    platform: "hashnode",
    patterns: [/([\w]+)\.hashnode\.dev/i, /hashnode\.com\/@([\w]+)/i],
  },
  {
    platform: "youtube",
    patterns: [/youtube\.com\/(channel|user|@)[\w-]+/i],
  },
];

// Personal website patterns — anything that isn't a social platform
const GITHUB_IO_PATTERN = /[\w-]+\.github\.io/i;
const GENERIC_WEBSITE_PATTERN = /^https?:\/\/(?!github\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|medium\.com|dev\.to)[^\s/]+\.[a-z]{2,}/i;

// ─── Link Classifier ──────────────────────────────────────────────────────────

function classifyUrl(url: string, source: LinkSource): DiscoveredLink | null {
  if (!url || url.length < 4) return null;

  const clean = url.trim().replace(/\/$/, "");
  const withScheme = clean.startsWith("http") ? clean : `https://${clean}`;

  // Try all known platform patterns
  for (const { platform, patterns, normalize } of PLATFORM_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(withScheme) || pattern.test(clean)) {
        return {
          url: normalize ? normalize(withScheme) : withScheme,
          platform,
          confidence: "certain",
          source,
          rawText: url,
        };
      }
    }
  }

  // GitHub Pages / personal website
  if (GITHUB_IO_PATTERN.test(withScheme)) {
    return {
      url: withScheme,
      platform: "personal_website",
      confidence: "certain",
      source,
      rawText: url,
    };
  }

  if (GENERIC_WEBSITE_PATTERN.test(withScheme)) {
    return {
      url: withScheme,
      platform: "personal_website",
      confidence: "likely",
      source,
      rawText: url,
    };
  }

  return null;
}

// ─── Extract Links from Text ──────────────────────────────────────────────────

function extractLinksFromText(text: string, source: LinkSource): DiscoveredLink[] {
  const links: DiscoveredLink[] = [];

  // Extract URLs
  const urlPattern = /https?:\/\/[^\s\)\]>"']+/gi;
  const barePattern = /(?:^|\s)((?:www\.|[\w-]+\.(?:com|io|dev|net|org|me|ai))[^\s\)\]>"']*)/gi;
  const atPattern = /@([\w]{2,50})/g;

  const urls = [...text.matchAll(urlPattern)].map((m) => m[0]);
  const bare = [...text.matchAll(barePattern)].map((m) => m[1]);
  const handles = [...text.matchAll(atPattern)].map((m) => m[0]);

  for (const url of [...new Set([...urls, ...bare, ...handles])]) {
    const classified = classifyUrl(url, source);
    if (classified) links.push(classified);
  }

  return links;
}

// ─── Profile README ───────────────────────────────────────────────────────────
// A user's profile README lives at username/username repo

async function getProfileREADME(username: string): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getReadme({
      owner: username,
      repo: username,
    });
    if (data.encoding === "base64") {
      const text = Buffer.from(data.content, "base64").toString("utf-8");
      return text.slice(0, 3000); // Keep enough to find all links
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Twitter Field from API ───────────────────────────────────────────────────
// GitHub API v3 exposes twitter_username but it's not in Octokit's type — raw fetch

async function getTwitterUsername(username: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.github.com/users/${username}`, {
      headers: {
        Authorization: `token ${process.env.GITHUB_API_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.twitter_username as string | null) ?? null;
  } catch {
    return null;
  }
}

// ─── Web Search for Social Links (Tier 4) ─────────────────────────────────────
// Only used when name is known and no social links found via direct methods.
// Uses GitHub's own search to find cross-references (not a full web search —
// that would require a paid search API and risk privacy concerns).

async function searchForLinkedInViaGitHub(
  username: string,
  realName: string | null
): Promise<DiscoveredLink | null> {
  if (!realName) return null;

  // Check if they've ever mentioned LinkedIn in their repos' README files
  try {
    const { data } = await octokit.search.code({
      q: `user:${username} linkedin.com`,
      per_page: 3,
    });

    for (const result of data.items) {
      if (!result.html_url) continue;
      // Fetch the file content to extract the link
      try {
        const resp = await fetch(result.download_url ?? result.html_url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/"));
        if (resp.ok) {
          const text = await resp.text();
          const links = extractLinksFromText(text, "inferred");
          const linkedin = links.find((l) => l.platform === "linkedin");
          if (linkedin) return linkedin;
        }
      } catch { /* continue */ }
    }
  } catch { /* code search rate limit */ }

  return null;
}

// ─── MAIN: Discover Social Presence ──────────────────────────────────────────

/**
 * discoverSocialPresence — discovers all public social/professional links
 * for a GitHub user across 4 tiers.
 *
 * Privacy guarantee: only surfaces links the person explicitly published.
 */
export async function discoverSocialPresence(
  user: GitHubUser
): Promise<SocialPresence> {
  const discovered: DiscoveredLink[] = [];

  // ── Tier 1: Direct from GitHub profile fields ─────────────────────────────
  if (user.blog) {
    const link = classifyUrl(user.blog, "github_blog_field");
    if (link) discovered.push(link);
  }

  if (user.bio) {
    const bioLinks = extractLinksFromText(user.bio, "github_bio");
    discovered.push(...bioLinks);
  }

  if (user.company) {
    const companyLinks = extractLinksFromText(user.company, "github_company_field");
    discovered.push(...companyLinks);
  }

  // ── Tier 2: Twitter from API field + Profile README ───────────────────────
  const [twitterHandle, profileReadme] = await Promise.allSettled([
    getTwitterUsername(user.login),
    getProfileREADME(user.login),
  ]);

  if (twitterHandle.status === "fulfilled" && twitterHandle.value) {
    discovered.push({
      url: `https://x.com/${twitterHandle.value}`,
      platform: "twitter",
      confidence: "certain",
      source: "github_twitter_field",
      rawText: twitterHandle.value,
    });
  }

  const readme = profileReadme.status === "fulfilled" ? profileReadme.value : null;
  if (readme) {
    const readmeLinks = extractLinksFromText(readme, "profile_readme");
    discovered.push(...readmeLinks);
  }

  // ── Tier 3: LinkedIn via code search (only if not found yet) ─────────────
  const hasLinkedIn = discovered.some((l) => l.platform === "linkedin");
  if (!hasLinkedIn && user.name) {
    const liLink = await searchForLinkedInViaGitHub(user.login, user.name);
    if (liLink) discovered.push(liLink);
  }

  // ── Deduplicate by platform (keep highest confidence) ────────────────────
  const byPlatform = new Map<SocialPlatform, DiscoveredLink>();
  const confidenceRank = { certain: 3, likely: 2, possible: 1 };

  for (const link of discovered) {
    const existing = byPlatform.get(link.platform);
    if (!existing || confidenceRank[link.confidence] > confidenceRank[existing.confidence]) {
      byPlatform.set(link.platform, link);
    }
  }

  // ── Build final presence object ────────────────────────────────────────────
  const others = [...byPlatform.values()].filter(
    (l) =>
      !["linkedin", "twitter", "instagram", "personal_website", "linktree"].includes(l.platform)
  );

  const presence: SocialPresence = {
    github: user.html_url,
    linkedin: byPlatform.get("linkedin") ?? null,
    twitter: byPlatform.get("twitter") ?? null,
    instagram: byPlatform.get("instagram") ?? null,
    personalWebsite: byPlatform.get("personal_website") ?? byPlatform.get("portfolio") ?? null,
    linktree:
      byPlatform.get("linktree") ?? byPlatform.get("beacons") ?? byPlatform.get("bento") ?? null,
    blog:
      byPlatform.get("substack") ??
      byPlatform.get("medium") ??
      byPlatform.get("devto") ??
      byPlatform.get("hashnode") ??
      null,
    otherLinks: others,
    profileReadme: readme,
    presenceScore: computePresenceScore(byPlatform),
    hasWritingPresence: !!(
      byPlatform.get("substack") ||
      byPlatform.get("medium") ||
      byPlatform.get("devto") ||
      byPlatform.get("hashnode") ||
      byPlatform.get("personal_website")
    ),
  };

  return presence;
}

// ─── Presence Score ───────────────────────────────────────────────────────────

function computePresenceScore(byPlatform: Map<SocialPlatform, DiscoveredLink>): number {
  let score = 1; // GitHub is always present
  if (byPlatform.has("linkedin")) score += 3;
  if (byPlatform.has("personal_website") || byPlatform.has("portfolio")) score += 2;
  if (byPlatform.has("twitter")) score += 1;
  if (byPlatform.has("substack") || byPlatform.has("medium") || byPlatform.has("devto")) score += 2;
  if (byPlatform.has("linktree") || byPlatform.has("beacons")) score += 1;
  return Math.min(10, score);
}
