# Agent System Architecture
# Full Agent Pipeline Design
# ════════════════════════════════════════════════════════════════════════════════

# "Open source hides a long tail of QUIET CAPABILITY waiting to be discovered."

# Core insight: the best engineers in hard domains (systems, robotics, infra,
# compilers) often have no LinkedIn, low follower counts, few stars — but their
# code tells an entirely different story.
#
# Anti-pattern to avoid: rewarding fame, rewarding activity, rewarding visibility.
# We reward: DEPTH, NOVELTY, CRAFT, IMPACT ON OTHERS' WORK.

## ════════════════════════════════════════════════════════════════════════════════
## FULL AGENT PIPELINE
## ════════════════════════════════════════════════════════════════════════════════
#
#  [Raw User Input]
#       │
#  ┌────▼────────────────────────────────────────────────────────────────────┐
#  │  AGENT 0 · InputSanitizer                                               │
#  │  Prompt injection defense → truncate → normalize → classify → extract   │
#  └────┬────────────────────────────────────────────────────────────────────┘
#       │  SanitizedInput { clean, classification, structure }
#  ┌────▼────────────────────────────────────────────────────────────────────┐
#  │  AGENT 1 · QueryAnalyzer                                                │
#  │  Stage 1: Gibberish → Expert rewrite                                    │
#  │  Stage 2: Expert query → Search signals                                 │
#  └────┬────────────────────────────────────────────────────────────────────┘
#       │  QueryAnalysis { rewrite, domains, skills, githubSearchTerms, ... }
#  ┌────▼────────────────────────────────────────────────────────────────────┐
#  │  AGENT 2 · DiscoveryOrchestrator                         ← MAIN FOCUS   │
#  │                                                                          │
#  │  Runs 9 parallel unconventional discovery strategies:                   │
#  │                                                                          │
#  │  Strategy A · TopicGraphMiner                                           │
#  │    → Searches niche topic tags, not just keywords in names              │
#  │    → Asks: "Who owns repos tagged with BOTH these obscure topics?"      │
#  │                                                                          │
#  │  Strategy B · ContributorNetworkTracer                                  │
#  │    → Finds contributors to key repos in the domain                      │
#  │    → Asks: "Who has committed to 2+ important repos without owning?"    │
#  │    → These are the silent experts, the behind-the-scenes builders       │
#  │                                                                          │
#  │  Strategy C · IssueIntelligenceMiner                                    │
#  │    → Searches GitHub issues for deep technical commentary               │
#  │    → Asks: "Who writes issues that demonstrate first-principles         │
#  │             understanding, not just bug reports?"                       │
#  │                                                                          │
#  │  Strategy D · ForkEvolutionDetector                                     │
#  │    → Finds forks that meaningfully diverged from originals              │
#  │    → Asks: "Who forked X and built something genuinely different?"      │
#  │    → Signals: creative adaptation, not copy-paste                       │
#  │                                                                          │
#  │  Strategy E · HiddenGemScanner                                          │
#  │    → Finds repos with deep READMEs but low follower counts              │
#  │    → Asks: "Who built something real that nobody famous noticed yet?"   │
#  │    → Inverse of vanity: high effort, low exposure = hidden talent       │
#  │                                                                          │
#  │  Strategy F · DomainLongevityTracer                                     │
#  │    → Finds engineers active in a specific domain for 3+ years           │
#  │    → Asks: "Who has been quietly working in this space for years?"      │
#  │    → Sustained focus is a stronger signal than viral bursts             │
#  │                                                                          │
#  │  Strategy G · CrossDomainTransferDetector                               │
#  │    → Finds engineers who apply domain expertise from adjacent fields    │
#  │    → Asks: "Who brings hardware thinking to software, or               │
#  │             research thinking to engineering?"                          │
#  │                                                                          │
#  │  Strategy H · PackageEcosystemMiner                                     │
#  │    → Searches npm/crates.io/PyPI for packages by the signal keywords    │
#  │    → Asks: "Who has PUBLISHED a library in this domain?"                │
#  │    → Publishing = deepest form of expertise signal                      │
#  │                                                                          │
#  │  Strategy I · DirectGitHubSearch (baseline)                             │
#  │    → The conventional multi-query GitHub search                         │
#  │    → Kept but de-prioritized relative to strategies above               │
#  │                                                                          │
#  │  All strategies fan out in parallel.                                    │
#  │  Results are de-duped and passed to Agent 2b.                           │
#  │                                                                          │
#  ├──────────────────────────────────────────────────────────────────────────┤
#  │  AGENT 2b · BotDetector                                                 │
#  │                                                                          │
#  │  Multi-signal scoring system. Each signal voted independently.          │
#  │  A profile passes only if botScore < threshold.                         │
#  │                                                                          │
#  │  Hard disqualifiers (any = instant reject):                             │
#  │  ✗ Username is random alphanumeric (entropy > 4.0 bits/char)            │
#  │  ✗ Account < 14 days old with > 100 commits                             │
#  │  ✗ All repos are forks with zero original content                       │
#  │  ✗ 0 followers AND 0 following AND 0 bio AND 0 public repos > 0 stars   │
#  │  ✗ GitHub "verified" bot patterns in username/bio                       │
#  │                                                                          │
#  │  Soft signals scored -1 to +3 each:                                     │
#  │  · Commit message variance (low variance = likely bot)                  │
#  │  · Issue/PR engagement (bots don't respond to comments)                 │
#  │  · Account age relative to activity density                             │
#  │  · Bio completeness (real humans write bios)                            │
#  │  · Profile picture (Gravatar/custom vs default GitHub avatar)           │
#  │  · Repo README quality (bots don't write thorough READMEs)              │
#  │  · Language diversity (bots tend to be monolingual)                     │
#  │  · Contribution timing distribution (bots commit at regular intervals)  │
#  │  · External link in profile (blog/website = real person signal)         │
#  │  · Response to star/fork events (engagement with community)             │
#  │                                                                          │
#  │  LLM verification for borderline cases (0.35–0.55 score zone).         │
#  │                                                                          │
#  ├──────────────────────────────────────────────────────────────────────────┤
#  │  AGENT 2c · DiscoveryExplainer                                          │
#  │                                                                          │
#  │  For each surviving candidate, records HOW they were found:             │
#  │  · Which strategy discovered them                                        │
#  │  · What specific signal triggered their inclusion                       │
#  │  · Why they are "overlooked" (what conventional search would miss)      │
#  │                                                                          │
#  │  This is shown in the UI as the "found via..." card — helps recruiters  │
#  │  understand WHY they should look at someone non-obvious.                │
#  └────┬────────────────────────────────────────────────────────────────────┘
#       │  DiscoveredCandidate[] { user, botScore, discoveryPath, whyOverlooked }
#  ┌────▼────────────────────────────────────────────────────────────────────┐
#  │  AGENT 3 · ProfileAnalyzer                                              │
#  │                                                                          │
#  │  Deep AI analysis of each candidate's actual work.                      │
#  │  Cache: Redis → DB → Fresh (24h TTL)                                    │
#  │                                                                          │
#  │  BIAS FIREWALL — the following are STRIPPED before Claude sees them:   │
#  │  ✗ Follower count                                                        │
#  │  ✗ Star counts on repos                                                  │
#  │  ✗ Fork counts                                                           │
#  │  ✗ Company affiliation (ex-Google/Meta should not get score bonus)      │
#  │  ✗ Location / nationality signals                                        │
#  │  ✗ Account age                                                           │
#  │  ✗ Contributor rank on any repo                                          │
#  │                                                                          │
#  │  What Claude IS given:                                                   │
#  │  ✓ Repository names and descriptions                                     │
#  │  ✓ README excerpts (what they built + how they explain it)              │
#  │  ✓ Topic tags they assigned                                              │
#  │  ✓ Languages used                                                        │
#  │  ✓ Issue/PR excerpts (how they reason about problems)                   │
#  │  ✓ Commit message samples (how they think and communicate)              │
#  │  ✓ Code structure signals (complexity, architecture choices)            │
#  │                                                                          │
#  │  Output: { headline, domains, skills, strengths, projects,              │
#  │            possibilities, craftSignals, expertiseScore }                │
#  │                                                                          │
#  │  Note: expertiseScore = DEPTH + CRAFT + IMPACT — not fame.             │
#  │  Note: "possibilities" replaces "good/bad" — per SkillSync's ethos.    │
#  └────┬────────────────────────────────────────────────────────────────────┘
#       │  ProfileAnalysis[]
#  ┌────▼────────────────────────────────────────────────────────────────────┐
#  │  AGENT 4 · SemanticRanker                                               │
#  │                                                                          │
#  │  Ranks candidates by relevance to the SPECIFIC query.                  │
#  │  Semantic matching — not keyword overlap.                               │
#  │                                                                          │
#  │  Ranking factors (all about fit, not absolute quality):                 │
#  │  · Domain alignment                                                      │
#  │  · Skill intersection depth                                              │
#  │  · Evidence specificity (are the claims backed by actual repos?)        │
#  │  · Unconventional relevance (adjacent expertise that transfers)         │
#  │  · Discovery path weight (contributor > direct search = more "hidden")  │
#  │                                                                          │
#  │  Output: RankedResult[] { profile, relevanceScore, matchReasons,       │
#  │                           standoutFact, matchedSkills, howHidden }      │
#  └────┬────────────────────────────────────────────────────────────────────┘
#       │
#  [Search Results Page — ranked, explained, bias-free]

## ════════════════════════════════════════════════════════════════════════════════
## AGENT 2 — DISCOVERY STRATEGIES: UNCONVENTIONAL QUESTIONS
## ════════════════════════════════════════════════════════════════════════════════
#
# The question each strategy is answering about the domain:
#
# A. TopicGraphMiner
#    Q: "Who has self-tagged their repos with the precise niche topic clusters
#        that define this problem domain — not marketing terms, but real ones?"
#    Why unconventional: GitHub topics are underused. Engineers who use precise
#    topics are signaling mastery, not visibility.
#    API: GET /search/repositories?q=topic:X+topic:Y
#    Then extract owners who recur across multiple topic combinations.
#
# B. ContributorNetworkTracer
#    Q: "Who has contributed to 2 or more high-signal repos in this domain
#        without owning any of them — the builders behind others' builders?"
#    Why unconventional: contributor lists are never searched. A person who
#    fixes critical bugs or adds core features to 3 foundational OSS projects
#    is elite talent hiding in plain sight.
#    API: GET /repos/{owner}/{repo}/contributors → cross-reference
#
# C. IssueIntelligenceMiner
#    Q: "Who writes GitHub issues that demonstrate first-principles
#        understanding? Who diagnoses root causes, not just symptoms?"
#    Why unconventional: issues are completely ignored by all recruiting tools.
#    A person who files a detailed, well-structured issue with reproduction
#    steps, root cause analysis, and proposed fix is demonstrating expertise
#    that no resume would capture.
#    API: GET /search/issues?q=label:bug+commenter:X (indirectly via code search)
#
# D. ForkEvolutionDetector
#    Q: "Who forked a key repo and pushed it in a meaningfully different
#        direction — showing they understood it deeply enough to extend it?"
#    Why unconventional: everyone ignores forks. But a fork with 200 commits
#    beyond the original, solving a real gap, signals deep domain expertise.
#    API: GET /repos/{owner}/{repo}/forks → filter by divergence (ahead_by)
#
# E. HiddenGemScanner
#    Q: "Who built something real, wrote a thorough README, has 0-50 stars,
#        and hasn't been discovered yet?"
#    Why unconventional: inverts the star filter most tools apply. The best
#    engineers working on hard problems often have niche audiences.
#    API: GET /search/repositories?q=topic:X+stars:0..50+readme:detailed
#
# F. DomainLongevityTracer
#    Q: "Who has been consistently committing to domain-relevant repos for
#        3+ years — not a recent clout chaser, but a long-term builder?"
#    Why unconventional: longevity is invisible in all tools. A person with
#    3 years of quiet, consistent work in embedded Rust is more trustworthy
#    than a person with 6 months of visible activity.
#    API: /search/commits + /repos/{owner}/{repo}/commits?since=3_years_ago
#
# G. CrossDomainTransferDetector
#    Q: "Who brings knowledge from domain X into domain Y in a way that
#        most domain-Y specialists haven't thought of?"
#    Why unconventional: the most innovative engineers are often the ones
#    who import thinking from adjacent fields. A hardware engineer writing
#    Rust systems software brings instincts that pure software people lack.
#    Detection: Claude analyzes multi-domain repo portfolios for rare combinations.
#
# H. PackageEcosystemMiner
#    Q: "Who has PUBLISHED a package/crate/library that others actually use?"
#    Why unconventional: npm/crates.io/PyPI are never searched for talent.
#    Publishing a package is the deepest expertise signal. You don't publish
#    a crate unless you're confident enough in your domain understanding.
#    API: crates.io/api/v1/crates?q=X | pypi.org/search | npmjs.com/search
#    then trace back to GitHub profiles.
#
# I. DirectGitHubSearch (baseline, lowest weight)
#    Q: "Who appears when you search GitHub users/repos with keyword combos?"
#    This is what every tool does. We include it but weight it least.

## ════════════════════════════════════════════════════════════════════════════════
## BOT DETECTION — SIGNAL SCORING TABLE
## ════════════════════════════════════════════════════════════════════════════════
#
# Signal                              | Human Signal | Bot Signal
# ─────────────────────────────────────────────────────────────────
# Username entropy                    | Low (words)  | High (random)
# Account age vs commit density       | Spread out   | Sudden spike
# Bio presence and quality            | Present      | Missing
# Custom avatar                       | Yes          | GitHub default
# Follower/following ratio            | 0.3–3.0      | 0 or >1000
# Issue comment history               | Present      | None
# Commit message variance             | High         | Low / templated
# Repo README depth                   | Varies       | None / auto-gen
# Original repos vs fork ratio        | Mixed        | All forks
# External links in profile           | Often        | Never
# Timezone distribution of commits    | Clustered    | Perfectly even
# Self-mentions in commit messages    | Rare         | Frequent
# Release notes authored              | If publib    | Never
# Blog/website linked                 | Often        | Never
# Issue response rate (own repos)     | >0           | Zero

## ════════════════════════════════════════════════════════════════════════════════
## BIAS FIREWALL DESIGN
## ════════════════════════════════════════════════════════════════════════════════
#
# The bias firewall operates between data collection and AI analysis.
# It strips identifying and social-proof signals before Claude evaluates.
#
# STRIPPED (social proof / demographic):
#   - Star counts (fame bias)
#   - Fork counts (viral bias)  
#   - Follower/following counts (network bias)
#   - Company affiliation (brand bias)
#   - Location / timezone (geographic bias)
#   - Account age (experience-assumption bias)
#   - Contributor rank on external repos (hierarchy bias)
#   - Email domain (institutional bias)
#
# PRESERVED (craft / depth signals):
#   - Repo descriptions and README content (what they built)
#   - Code language and architecture choices (how they built it)
#   - Commit message samples (how they think)
#   - Issue/PR excerpts (how they reason and communicate)
#   - Topic self-assignments (how they classify their own work)
#   - Dependency choices in code (what tools they reach for)
#   - Test coverage presence (care for craft)
#   - Documentation depth (communication ability)
#   - Problem domain specificity (depth over breadth)
#
# Claude is also EXPLICITLY instructed:
#   - Do not infer demographics from name or username
#   - Do not value work from known companies over unknown
#   - Do not assume seniority from follower count
#   - A solo project with deep architecture beats a famous FAANG contribution
