# BeyondPaper — Find Elite Engineers via Open Source Signal

> *SkillSync-inspired talent discovery, powered by a 6-agent AI system. Zero cost. Zero database. Zero Supabase.*

---

## Why DevHunt Wins

Traditional hiring looks at resumes. DevHunt reads **real open source work**.

Instead of mis-hiring risks from curated LinkedIn profiles, DevHunt surfaces:
- **Hidden gems** — high-skill engineers with low follower counts
- **Domain depth** — not just stars, but *what* they built and *how*
- **Honest assessment** — red flags, green flags, and tailored interview questions

---

## Architecture — 6-Agent AI System

```
User Query (natural language)
        │
        ▼
┌──────────────────────────────┐
│  AGENT 1: Query Parser       │  Claude AI → GitHub search syntax
└────────────────┬─────────────┘
                 │
                 ▼
┌──────────────────────────────┐
│  AGENT 2: User Discoverer    │  GitHub Search API → candidate list
└────────────────┬─────────────┘
                 │
                 ▼ (parallel per user)
┌──────────────────────────────┐
│  AGENT 3: Data Fetcher       │  GitHub REST API → profile + repos + READMEs
└────────────────┬─────────────┘
                 │
                 ▼
┌──────────────────────────────┐
│  AGENT 4: Skill Analyzer     │  Claude AI → structured JSON assessment
└────────────────┬─────────────┘
                 │
                 ▼
┌──────────────────────────────┐
│  AGENT 5: Ranker             │  Pure JS → live sorted results
└────────────────┬─────────────┘
                 │
                 ▼ (on demand)
┌──────────────────────────────┐
│  AGENT 6: Deep Profiler      │  Claude AI → full technical assessment
└──────────────────────────────┘
```

---

## Tech Stack — 100% Free Tier

| Layer | Technology | Cost |
|-------|-----------|------|
| Frontend | Next.js 14 (App Router) | Free |
| Deployment | Vercel (free tier) | $0 |
| AI Brain | Anthropic Claude Sonnet | Free tier |
| Data Source | GitHub REST API | Free (60–5000 req/hr) |
| Database | **None** — stateless by design | $0 |
| Auth | **None** — no login required | $0 |
| Cache | In-memory + Next.js revalidate | $0 |

**Total monthly cost: $0**

---

## Risk Elimination (the SkillSync insight)

| Risk | Traditional Hiring | DevHunt |
|------|-------------------|---------|
| Mis-hire | Resume inflation | Real code as signal |
| Discovery | LinkedIn only | All of GitHub |
| Bias | Self-reported skills | Demonstrated capability |
| Speed | Weeks of screening | Minutes of AI analysis |
| Hidden talent | Never found | Explicitly surfaced |

---

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd devhunt
npm install

# 2. Set environment variables
cp .env.example .env.local
# Edit .env.local with your ANTHROPIC_API_KEY

# 3. Run locally
npm run dev
# → http://localhost:3000

# 4. Deploy to Vercel
npx vercel --prod
# Add ANTHROPIC_API_KEY in Vercel dashboard → Settings → Environment Variables
```

---

## Environment Variables

```bash
# Required — Anthropic API key (https://console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-...

# Optional — increases GitHub rate limit: 60 → 5,000 req/hr
# Get free at: GitHub → Settings → Developer settings → Personal access tokens
NEXT_PUBLIC_GITHUB_TOKEN=ghp_...
```

---

## Project Structure

```
devhunt/
├── app/
│   ├── layout.jsx              # Root layout + metadata
│   ├── globals.css             # Design tokens + animations
│   ├── page.jsx                # Main UI (all views + components)
│   └── api/claude/route.js     # Server-side Claude proxy (keeps API key safe)
├── lib/
│   ├── agents.js               # 6-agent system + pipeline orchestrator
│   └── github.js               # GitHub API client (rate limit handling)
├── .env.example
├── next.config.js
└── package.json
```

---

## Key Design Decisions

**No database needed** — every search is stateless. Results are computed on-demand from
GitHub API + Claude AI. This means zero infrastructure cost and zero data liability.

**API key security** — Claude API key lives server-side in `/api/claude/route.js`.
GitHub token is optional and only increases rate limits (not required for demo).

**Progressive results** — results stream in as each engineer is analyzed.
Users see the first cards within ~10 seconds.

**Graceful degradation** — if one user fails to analyze, the pipeline skips and continues.
Rate limit errors surface clearly with instructions to add a token.

**Abort on re-search** — the AbortController pattern cancels in-flight searches instantly.

---

## Scaling Beyond the Hackathon

When this takes off:
1. **Redis caching** — Upstash free tier (26MB) caches analyses for 24h
2. **GitHub OAuth** — adds 5,000 req/hr per authenticated user automatically
3. **Postgres** — Neon free tier for saved searches and user history
4. **Rate limiting** — Upstash ratelimit for the `/api/claude` route

---

## Built for

This project was built for [Hackathon Name] with the goal of funding [NGO Name].
All proceeds from any commercial success will go toward [NGO mission].

---

*No forms. No surveys. Just signal from real work.*
