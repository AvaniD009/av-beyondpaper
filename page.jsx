"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { runSearchPipeline, agentDeepProfiler } from "../lib/agents"

// ── Constants ──────────────────────────────────────────────────────────────

const DEPTH = {
  shallow:      { label: "Learner",      color: "#5e5e72", bg: "rgba(94,94,114,0.12)"  },
  intermediate: { label: "Practitioner", color: "#58a6ff", bg: "rgba(88,166,255,0.12)" },
  deep:         { label: "Expert",       color: "#a3ff6f", bg: "rgba(163,255,111,0.12)"},
  expert:       { label: "Visionary",    color: "#f5a623", bg: "rgba(245,166,35,0.12)" },
}

const HIRE = {
  "strong hire": { color: "#a3ff6f", bg: "rgba(163,255,111,0.12)", border: "rgba(163,255,111,0.3)", label: "Strong Hire" },
  "consider":    { color: "#f5a623", bg: "rgba(245,166,35,0.12)",  border: "rgba(245,166,35,0.3)",  label: "Consider"    },
  "pass":        { color: "#ff5f57", bg: "rgba(255,95,87,0.12)",   border: "rgba(255,95,87,0.3)",   label: "Pass"        },
}

const EXAMPLE_SEARCHES = [
  "ML infrastructure engineer specializing in model serving",
  "Rust systems programmer working on distributed databases",
  "Frontend engineer obsessed with performance and accessibility",
  "Security researcher focused on cryptography and zero-knowledge proofs",
  "WebAssembly compiler engineer from India",
]

// ── Score Ring ──────────────────────────────────────────────────────────────

function ScoreRing({ score, size = 54 }) {
  const r = (size - 8) / 2
  const circ = 2 * Math.PI * r
  const color = score >= 80 ? "var(--accent)" : score >= 60 ? "var(--amber)" : "var(--info)"

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface3)" strokeWidth={4}/>
      <circle
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke={color} strokeWidth={4} strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ - (score / 100) * circ}
        className="score-ring"
        style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
      />
      <text
        x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        fontSize={score >= 100 ? 11 : 13} fontWeight={600} fill="var(--text)"
        fontFamily="var(--font-mono)"
      >
        {score}
      </text>
    </svg>
  )
}

// ── Skeleton Card ───────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 14, alignItems: "center" }}>
        <div className="skeleton" style={{ width: 44, height: 44, borderRadius: "50%" }}/>
        <div style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 16, width: "55%", marginBottom: 6 }}/>
          <div className="skeleton" style={{ height: 12, width: "35%" }}/>
        </div>
        <div className="skeleton" style={{ width: 54, height: 54, borderRadius: "50%" }}/>
      </div>
      <div className="skeleton" style={{ height: 13, marginBottom: 6 }}/>
      <div className="skeleton" style={{ height: 13, width: "80%" , marginBottom: 16 }}/>
      <div style={{ display: "flex", gap: 6 }}>
        {[60, 80, 55].map((w, i) => (
          <div key={i} className="skeleton" style={{ height: 22, width: w, borderRadius: 100 }}/>
        ))}
      </div>
    </div>
  )
}

// ── Profile Card ────────────────────────────────────────────────────────────

function ProfileCard({ profile, onSelect, index }) {
  const { login, avatar_url, githubData, analysis } = profile
  const depth = DEPTH[analysis.depth] || DEPTH.intermediate

  return (
    <div
      className="card"
      style={{
        padding: 20, cursor: "pointer", position: "relative", overflow: "hidden",
        animation: `fadeUp 0.45s ease ${Math.min(index, 6) * 0.07}s both`,
      }}
      onClick={() => onSelect(profile)}
    >
      {/* Hidden gem badge */}
      {analysis.hiddenGem && (
        <div style={{
          position: "absolute", top: 14, right: 14,
          background: "var(--amber-dim)", border: "1px solid var(--amber-border)",
          color: "var(--amber)", borderRadius: 100, padding: "2px 8px",
          fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600, letterSpacing: "0.05em",
        }}>
          ◆ HIDDEN GEM
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
        <img
          src={avatar_url} alt={login}
          style={{ width: 44, height: 44, borderRadius: "50%", border: "2px solid var(--border)", flexShrink: 0 }}
          onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${login}&background=1c1e27&color=a3ff6f` }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {githubData?.name || login}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
            @{login}
          </div>
          {githubData?.location && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              📍 {githubData.location}
            </div>
          )}
        </div>
        <ScoreRing score={analysis.relevanceScore} size={54}/>
      </div>

      {/* Domain blurb */}
      <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55, marginBottom: 14, opacity: 0.88 }}>
        {analysis.domainExpertise}
      </p>

      {/* Skills */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
        {analysis.skills?.slice(0, 5).map(s => (
          <span key={s} className="tag" style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}>
            {s}
          </span>
        ))}
        {(analysis.skills?.length || 0) > 5 && (
          <span className="tag" style={{ background: "var(--surface2)", color: "var(--muted)" }}>
            +{analysis.skills.length - 5}
          </span>
        )}
      </div>

      {/* Depth + stats */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: analysis.standoutProject ? 12 : 0 }}>
        <span className="tag" style={{ background: depth.bg, color: depth.color, border: `1px solid ${depth.color}33` }}>
          {depth.label}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          {(githubData?.followers || 0).toLocaleString()} followers · {githubData?.public_repos || 0} repos
        </span>
      </div>

      {/* Standout project */}
      {analysis.standoutProject && (
        <div style={{
          padding: "10px 12px", background: "var(--surface2)", borderRadius: "var(--r-md)",
          borderLeft: "2px solid var(--amber)",
        }}>
          <div style={{ fontSize: 10, color: "var(--amber)", fontFamily: "var(--font-mono)", fontWeight: 600, marginBottom: 3, letterSpacing: "0.06em" }}>
            STANDOUT PROJECT
          </div>
          <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", marginBottom: 2 }}>
            {analysis.standoutProject}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
            {analysis.standoutReason}
          </div>
        </div>
      )}

      {/* CTA */}
      <div style={{
        marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)",
        fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontStyle: "italic" }}>{analysis.recommendation}</span>
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          Deep analysis →
        </span>
      </div>
    </div>
  )
}

// ── Agent Progress ──────────────────────────────────────────────────────────

function AgentProgress({ progress }) {
  const stages = [
    { id: "parse",    icon: "◎", label: "Query Agent" },
    { id: "discover", icon: "⊙", label: "Discovery Agent" },
    { id: "fetch",    icon: "⊕", label: "Data Agent" },
    { id: "analyze",  icon: "⊗", label: "Analysis Agent" },
    { id: "done",     icon: "✓", label: "Ranker Agent" },
  ]

  const activeIdx = stages.findIndex(s => s.id === progress.stage)

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 20px" }}>
      {/* Progress bar */}
      <div style={{ position: "relative", height: 3, background: "var(--surface3)", borderRadius: 10, marginBottom: 32, overflow: "hidden" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${progress.pct}%`, background: "var(--accent)",
          borderRadius: 10, transition: "width 0.4s ease",
          boxShadow: "0 0 10px rgba(163,255,111,0.4)",
        }}/>
      </div>

      {/* Stage list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {stages.map((s, i) => {
          const done    = i < activeIdx
          const active  = s.id === progress.stage
          const waiting = i > activeIdx

          return (
            <div key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 14, opacity: waiting ? 0.3 : 1, transition: "opacity 0.3s" }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: active ? 14 : 13,
                background: done ? "var(--accent-dim)" : active ? "var(--accent-dim)" : "var(--surface2)",
                border: `1px solid ${done || active ? "var(--accent-border)" : "var(--border)"}`,
                color: done || active ? "var(--accent)" : "var(--muted)",
                animation: active ? "pulse 1.2s ease infinite" : "none",
              }}>
                {done ? "✓" : s.icon}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, fontFamily: "var(--font-mono)", color: active ? "var(--text)" : "var(--text-secondary)", marginBottom: 2 }}>
                  {s.label}
                </div>
                {active && (
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {progress.label}
                    {progress.detail && (
                      <span style={{ marginLeft: 8, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                        {progress.detail}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Profile Drawer ──────────────────────────────────────────────────────────

function ProfileDrawer({ profile, onClose }) {
  const [deepData, setDeepData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState("overview")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDeepData(null)
    setActiveTab("overview")

    agentDeepProfiler(profile, profile.searchQuery)
      .then(data => { if (!cancelled) { setDeepData(data); setLoading(false) } })
      .catch(err => { console.error("Deep profile failed:", err); if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [profile.login])

  const hire = HIRE[deepData?.hiringRecommendation] || HIRE.consider
  const depth = DEPTH[profile.analysis.depth] || DEPTH.intermediate

  const tabs = ["overview", "projects", "interview"]

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "stretch",
    }}>
      {/* Backdrop */}
      <div
        style={{ flex: 1, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div style={{
        width: "min(640px, 100%)", background: "var(--surface)", borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column", overflowY: "auto",
        animation: "slideInRight 0.3s cubic-bezier(0.4,0,0.2,1)",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--surface)", zIndex: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <img
              src={profile.avatar_url} alt={profile.login}
              style={{ width: 52, height: 52, borderRadius: "50%", border: "2px solid var(--border)" }}
              onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${profile.login}&background=1c1e27&color=a3ff6f` }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, marginBottom: 2 }}>
                {profile.githubData?.name || profile.login}
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                @{profile.login}
                {profile.githubData?.location && ` · 📍 ${profile.githubData.location}`}
              </div>
              {loading ? (
                <div style={{ marginTop: 8 }}>
                  <div className="skeleton" style={{ height: 22, width: 120, borderRadius: 100 }}/>
                </div>
              ) : deepData && (
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="tag" style={{ background: hire.bg, color: hire.color, border: `1px solid ${hire.border}`, fontWeight: 600 }}>
                    {hire.label}
                  </span>
                  <span className="tag" style={{ background: depth.bg, color: depth.color }}>
                    {depth.label}
                  </span>
                  {profile.analysis.hiddenGem && (
                    <span className="tag" style={{ background: "var(--amber-dim)", color: "var(--amber)", border: "1px solid var(--amber-border)" }}>
                      ◆ Hidden Gem
                    </span>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a href={profile.html_url} target="_blank" rel="noopener noreferrer">
                <button className="btn btn-ghost" style={{ padding: "7px 12px", fontSize: 12 }}>
                  GitHub ↗
                </button>
              </a>
              <button className="btn btn-ghost" onClick={onClose} style={{ padding: "7px 12px", fontSize: 12 }}>
                ✕
              </button>
            </div>
          </div>

          {/* Headline */}
          {loading ? (
            <div style={{ marginTop: 14 }}>
              <div className="skeleton" style={{ height: 13, marginBottom: 6 }}/>
              <div className="skeleton" style={{ height: 13, width: "75%" }}/>
            </div>
          ) : deepData?.headline && (
            <p style={{ marginTop: 14, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, fontStyle: "italic" }}>
              "{deepData.headline}"
            </p>
          )}

          {/* Stats row */}
          <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
            {[
              { label: "Followers",  value: (profile.githubData?.followers || 0).toLocaleString() },
              { label: "Repos",      value: profile.githubData?.public_repos || 0 },
              { label: "Relevance",  value: `${profile.analysis.relevanceScore}%` },
            ].map(s => (
              <div key={s.label}>
                <div style={{ fontSize: 18, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{s.value}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", padding: "0 24px", position: "sticky", top: "192px", background: "var(--surface)", zIndex: 9 }}>
          {tabs.map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              style={{
                padding: "12px 16px", background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontFamily: "var(--font-body)", fontWeight: 500,
                color: activeTab === t ? "var(--accent)" : "var(--muted)",
                borderBottom: activeTab === t ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: -1, transition: "all 0.15s", textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: "24px", flex: 1 }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[100, 75, 90, 60].map((w, i) => (
                <div key={i} className="skeleton" style={{ height: 14, width: `${w}%` }}/>
              ))}
            </div>
          ) : !deepData ? (
            <p style={{ color: "var(--muted)", fontSize: 14 }}>Analysis unavailable. Try again.</p>
          ) : activeTab === "overview" ? (
            <OverviewTab profile={profile} deepData={deepData}/>
          ) : activeTab === "projects" ? (
            <ProjectsTab profile={profile} deepData={deepData}/>
          ) : (
            <InterviewTab deepData={deepData}/>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children, accentColor }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600, letterSpacing: "0.1em",
        color: accentColor || "var(--text-secondary)", marginBottom: 12, textTransform: "uppercase",
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function BulletList({ items, color }) {
  if (!items?.length) return <p style={{ fontSize: 13, color: "var(--muted)" }}>None identified</p>
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ color: color || "var(--accent)", fontSize: 10, marginTop: 4, flexShrink: 0 }}>●</span>
          <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{item}</span>
        </div>
      ))}
    </div>
  )
}

function OverviewTab({ profile, deepData }) {
  return (
    <div>
      <Section title="Technical Strengths" accentColor="var(--accent)">
        <BulletList items={deepData.technicalStrengths} color="var(--accent)"/>
      </Section>

      <Section title="Unique Insights">
        <BulletList items={deepData.uniqueInsights} color="var(--info)"/>
      </Section>

      <Section title="Green Flags" accentColor="var(--accent)">
        <BulletList items={deepData.greenFlags} color="var(--accent)"/>
      </Section>

      {deepData.redFlags?.length > 0 && (
        <Section title="Red Flags / Watch Points" accentColor="var(--danger)">
          <BulletList items={deepData.redFlags} color="var(--danger)"/>
        </Section>
      )}

      <Section title="Career Trajectory">
        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {deepData.careerTrajectory}
        </p>
      </Section>

      <Section title="Risk Assessment" accentColor="var(--amber)">
        <div style={{
          padding: "14px 16px", background: "var(--amber-dim)", borderRadius: "var(--r-md)",
          borderLeft: "2px solid var(--amber)",
        }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {deepData.riskAssessment}
          </p>
        </div>
      </Section>

      {/* Skills */}
      <Section title="Identified Skills">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {profile.analysis.skills?.map(s => (
            <span key={s} className="tag" style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}>
              {s}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Problem Solving Style">
        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, fontStyle: "italic" }}>
          "{profile.analysis.problemSolvingStyle}"
        </p>
      </Section>
    </div>
  )
}

function ProjectsTab({ profile, deepData }) {
  return (
    <div>
      <Section title="AI-Analyzed Top Projects" accentColor="var(--amber)">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {deepData.topProjects?.map((p, i) => (
            <div key={i} style={{
              padding: "16px", background: "var(--surface2)", borderRadius: "var(--r-md)",
              border: "1px solid var(--border)",
            }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                {p.name}
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: "var(--info)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em", fontWeight: 600 }}>
                  IMPACT ·
                </span>
                <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 6 }}>{p.impact}</span>
              </div>
              <div>
                <span style={{ fontSize: 10, color: "var(--amber)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em", fontWeight: 600 }}>
                  TECH ·
                </span>
                <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 6 }}>{p.techDetails}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="GitHub Repositories">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {profile.repos?.slice(0, 6).map(r => (
            <a
              key={r.name}
              href={r.html_url} target="_blank" rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <div style={{
                padding: "12px 14px", background: "var(--surface2)", borderRadius: "var(--r-md)",
                border: "1px solid var(--border)", transition: "border-color 0.2s",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--info)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.description || "No description"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexShrink: 0, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                  {r.language && <span>{r.language}</span>}
                  <span>⭐ {r.stargazers_count}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </Section>
    </div>
  )
}

function InterviewTab({ deepData }) {
  const [copied, setCopied] = useState(null)

  const copyQ = (q, i) => {
    navigator.clipboard?.writeText(q)
    setCopied(i)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div>
      <Section title="AI-Generated Interview Questions" accentColor="var(--info)">
        <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>
          These questions are tailored to this engineer's actual work — not generic templates.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {deepData.interviewQuestions?.map((q, i) => (
            <div key={i} style={{
              padding: "14px 16px", background: "var(--surface2)", borderRadius: "var(--r-md)",
              border: "1px solid var(--border)",
              display: "flex", gap: 12, alignItems: "flex-start",
            }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--info)", fontWeight: 600, marginTop: 2, flexShrink: 0 }}>
                Q{i + 1}
              </span>
              <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, flex: 1 }}>{q}</p>
              <button
                onClick={() => copyQ(q, i)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 11, flexShrink: 0, padding: "2px 6px" }}
              >
                {copied === i ? "✓" : "copy"}
              </button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ── Landing View ────────────────────────────────────────────────────────────

function LandingView({ onSearch }) {
  const [query, setQuery] = useState("")
  const [exampleIdx, setExampleIdx] = useState(0)
  const textareaRef = useRef(null)

  useEffect(() => {
    const interval = setInterval(() => {
      setExampleIdx(i => (i + 1) % EXAMPLE_SEARCHES.length)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  const submit = () => {
    if (query.trim()) onSearch(query.trim())
  }

  const handleKeyDown = e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px", position: "relative", overflow: "hidden" }}>
      {/* Background grid */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 0,
        backgroundImage: "linear-gradient(rgba(163,255,111,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(163,255,111,0.02) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
        maskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 100%)",
      }}/>

      <div style={{ position: "relative", zIndex: 1, maxWidth: 680, width: "100%", textAlign: "center" }}>
        {/* Badge */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 100, marginBottom: 32, fontSize: 12, color: "var(--muted)" }}>
          <span style={{ color: "var(--amber)", fontWeight: 700 }}>Y</span>
          <span style={{ color: "var(--border-hover)" }}>|</span>
          <span>Backed by Y Combinator</span>
        </div>

        {/* Heading */}
        <h1 style={{
          fontFamily: "var(--font-display)", fontSize: "clamp(32px, 6vw, 56px)", fontWeight: 800,
          lineHeight: 1.1, letterSpacing: "-0.02em", marginBottom: 20,
          color: "var(--text)",
        }}>
          Find elite, overlooked<br/>
          <span style={{ color: "var(--accent)" }}>engineers</span> via open source
        </h1>

        <p style={{ fontSize: 17, color: "var(--text-secondary)", lineHeight: 1.65, marginBottom: 40, maxWidth: 520, margin: "0 auto 40px" }}>
          No forms. No surveys. DevHunt's AI agents analyze real GitHub work to surface
          the engineers that traditional searches miss.
        </p>

        {/* Search box */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-xl)",
          overflow: "hidden", transition: "border-color 0.2s",
          boxShadow: "0 0 40px rgba(163,255,111,0.04)",
        }}>
          <textarea
            ref={textareaRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={EXAMPLE_SEARCHES[exampleIdx]}
            rows={3}
            style={{
              width: "100%", padding: "20px 24px", background: "transparent",
              border: "none", color: "var(--text)", fontSize: 16,
              fontFamily: "var(--font-body)", resize: "none", lineHeight: 1.5,
              caretColor: "var(--accent)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              ↵ search · ⇧↵ new line
            </span>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={!query.trim()}
            >
              <span>Search</span>
            </button>
          </div>
        </div>

        {/* How it works */}
        <div style={{ display: "flex", gap: 10, marginTop: 40, justifyContent: "center", flexWrap: "wrap" }}>
          {[
            { icon: "◎", label: "Query Agent", desc: "Parses intent" },
            { icon: "⊙", label: "Discovery Agent", desc: "Scans GitHub" },
            { icon: "⊕", label: "Data Agent", desc: "Fetches profiles" },
            { icon: "⊗", label: "Analysis Agent", desc: "Claude AI scoring" },
          ].map(a => (
            <div key={a.label} style={{
              padding: "10px 14px", background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: "var(--r-md)", textAlign: "left",
            }}>
              <div style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", fontSize: 13, marginBottom: 2 }}>
                {a.icon} {a.label}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{a.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Results View ─────────────────────────────────────────────────────────────

function ResultsView({ query, results, progress, onNewSearch, onSelectProfile, isSearching }) {
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `devhunt-${Date.now()}.json`
    a.click()
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Topbar */}
      <div style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(9,9,14,0.9)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
        padding: "14px 24px", display: "flex", alignItems: "center", gap: 16,
      }}>
        <button
          className="btn btn-ghost"
          onClick={onNewSearch}
          style={{ padding: "7px 12px", fontSize: 12 }}
        >
          ← New search
        </button>

        <div style={{
          flex: 1, padding: "8px 14px", background: "var(--surface)",
          border: "1px solid var(--border)", borderRadius: "var(--r-md)",
          fontSize: 13, color: "var(--text-secondary)", fontStyle: "italic",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {query}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {results.length > 0 && (
            <button className="btn btn-ghost" onClick={exportJSON} style={{ padding: "7px 12px", fontSize: 12 }}>
              Export JSON
            </button>
          )}
          <span style={{ padding: "7px 12px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
            {results.length} found
          </span>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 24px" }}>
        {isSearching && results.length === 0 ? (
          <AgentProgress progress={progress}/>
        ) : (
          <div>
            {/* Progress bar (when streaming results) */}
            {isSearching && (
              <div style={{ marginBottom: 20, padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", animation: "pulse 1s infinite", flexShrink: 0 }}/>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  {progress.label}
                  {progress.detail && <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", marginLeft: 8 }}>{progress.detail}</span>}
                </span>
                <div style={{ flex: 1, height: 2, background: "var(--surface3)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progress.pct}%`, background: "var(--accent)", transition: "width 0.4s ease" }}/>
                </div>
              </div>
            )}

            {/* Results grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 16,
            }}>
              {results.map((p, i) => (
                <ProfileCard key={p.id} profile={p} onSelect={onSelectProfile} index={i}/>
              ))}
              {/* Skeleton placeholders while loading */}
              {isSearching && results.length < 3 && (
                Array.from({ length: 3 - results.length }).map((_, i) => <SkeletonCard key={`sk-${i}`}/>)
              )}
            </div>

            {!isSearching && results.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>◌</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                  No engineers found
                </div>
                <p style={{ fontSize: 14 }}>Try a different search — be more specific about the technical domain.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Error Banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ error, onDismiss }) {
  return (
    <div style={{
      position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 200,
      padding: "12px 20px", background: "var(--danger-dim)", border: "1px solid rgba(255,95,87,0.4)",
      borderRadius: "var(--r-md)", color: "var(--danger)", fontSize: 13, maxWidth: 480, width: "90%",
      display: "flex", gap: 12, alignItems: "flex-start",
      animation: "fadeUp 0.3s ease",
    }}>
      <span style={{ flex: 1 }}>{error}</span>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 15, padding: 0 }}>✕</button>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView]           = useState("landing")   // landing | results
  const [query, setQuery]         = useState("")
  const [results, setResults]     = useState([])
  const [progress, setProgress]   = useState({ stage: "parse", label: "", pct: 0, detail: "" })
  const [isSearching, setIsSearching] = useState(false)
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [error, setError]         = useState(null)
  const abortRef = useRef(null)

  const handleSearch = useCallback(async (q) => {
    // Cancel any in-flight search
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setQuery(q)
    setResults([])
    setView("results")
    setIsSearching(true)
    setError(null)
    setSelectedProfile(null)

    try {
      await runSearchPipeline(q, {
        signal: controller.signal,
        onProgress: setProgress,
        onResult: setResults,
      })
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[App] Search error:", err)
        setError(
          err.message.includes("rate limit")
            ? "GitHub rate limit hit. Add a GITHUB_TOKEN to .env.local for 5,000 requests/hour."
            : `Search error: ${err.message}`
        )
      }
    } finally {
      setIsSearching(false)
    }
  }, [])

  const handleNewSearch = useCallback(() => {
    abortRef.current?.abort()
    setView("landing")
    setSelectedProfile(null)
    setError(null)
  }, [])

  return (
    <>
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)}/>}

      {view === "landing" && <LandingView onSearch={handleSearch}/>}

      {view === "results" && (
        <ResultsView
          query={query}
          results={results}
          progress={progress}
          isSearching={isSearching}
          onNewSearch={handleNewSearch}
          onSelectProfile={setSelectedProfile}
        />
      )}

      {selectedProfile && (
        <ProfileDrawer
          profile={selectedProfile}
          onClose={() => setSelectedProfile(null)}
        />
      )}
    </>
  )
}
