"use client";

import { useState } from "react";
import type { RankedResult } from "@/lib/agents/ranking";

const M = "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

// ── tiny helpers ──────────────────────────────────────────────────────────────

function Tag({ label, dim }: { label: string; dim?: boolean }) {
  return (
    <span style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 4,
      border: "1px solid #262626", color: dim ? "#484f58" : "#7d8590",
      background: "transparent", fontFamily: M, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 10, color: "#484f58", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8, fontFamily: M }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Bar({ score }: { score: number }) {
  return (
    <div style={{ flex: 1, height: 2, background: "#1c1c1c", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, score))}%`, height: "100%", background: "#39d353", borderRadius: 2, transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)" }} />
    </div>
  );
}

// ── main card ─────────────────────────────────────────────────────────────────

export default function CandidateCard({ result, rank }: { result: RankedResult; rank: number }) {
  const [open, setOpen] = useState(false);
  const { profile, finalScore, signatureStrength, whyRanked, discoveryPath,
          hiddenScore, whyOverlooked, dimensions, potentialProfile,
          strongWhy, cognitiveStyle, fairnessCertificate,
          transparencyCard, riskAudit, trendingContributions } = result;

  const missingGaps = potentialProfile?.ttp.gapEstimates.filter((g) => !g.alreadyHas) ?? [];
  const biasVerdict = fairnessCertificate?.overallVerdict ?? "CERTIFIED";
  const biasColor   = biasVerdict === "CERTIFIED" ? "#39d353" : biasVerdict === "CERTIFIED_WITH_NOTES" ? "#e6c84a" : "#c85050";

  return (
    <div
      style={{
        borderRadius: 10, border: "1px solid #262626", background: "#141414",
        overflow: "hidden", transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#333")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#262626")}
    >
      {/* ── collapsed header ────────────────────────────────────────────────── */}
      <div style={{ padding: "18px 20px", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>

          {/* Avatar + name */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img
              src={profile.avatar_url}
              alt={profile.username}
              style={{ width: 38, height: 38, borderRadius: "50%", border: "1px solid #262626", flexShrink: 0 }}
            />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <a
                  href={profile.github_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: "#e6edf3", fontWeight: 600, fontSize: 14, textDecoration: "none", fontFamily: M }}
                >
                  {profile.username}
                </a>
                <Tag label={`#${rank}`} />
                {discoveryPath && <Tag label={`via ${discoveryPath.replace(/_/g, " ")}`} dim />}
                {hiddenScore >= 7 && <Tag label="hidden gem" />}
                <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, border: `1px solid ${biasColor}33`, color: biasColor, fontFamily: M }}>
                  {biasVerdict === "CERTIFIED" ? "✓ bias-free" : biasVerdict === "CERTIFIED_WITH_NOTES" ? "~ reviewed" : "! check"}
                </span>
              </div>
              <div style={{ color: "#7d8590", fontSize: 12, marginTop: 3, fontFamily: M, lineHeight: 1.4 }}>
                {profile.headline}
              </div>
            </div>
          </div>

          {/* Score + chevron */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#39d353", lineHeight: 1, fontFamily: M }}>{finalScore}</div>
              <div style={{ fontSize: 10, color: "#484f58", fontFamily: M }}>/100</div>
            </div>
            <div style={{ color: "#484f58", fontSize: 12, transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none" }}>▾</div>
          </div>
        </div>

        {/* Signature strength */}
        {signatureStrength?.statement && (
          <div style={{
            marginTop: 12, padding: "9px 12px", borderRadius: 6,
            background: "rgba(57,211,83,0.04)", border: "1px solid rgba(57,211,83,0.12)",
            fontSize: 12, color: "#7d8590", lineHeight: 1.55, fontFamily: M,
          }}>
            <span style={{ color: "#39d353", fontWeight: 600 }}>⚡ </span>
            {signatureStrength.statement}
          </div>
        )}

        {/* Why ranked */}
        {whyRanked && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#7d8590", lineHeight: 1.6, fontFamily: M }}>
            {whyRanked}
          </div>
        )}

        {/* Top skills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
          {profile.skills.slice(0, 6).map((s) => (
            <span key={s.name} style={{
              fontSize: 11, padding: "3px 9px", borderRadius: 4,
              border: "1px solid #262626", color: "#7d8590", background: "#1c1c1c", fontFamily: M,
            }}>
              {s.name}
              {s.level === "expert" && <span style={{ color: "#39d353", marginLeft: 4 }}>·</span>}
            </span>
          ))}
          {profile.skills.length > 6 && (
            <span style={{ fontSize: 11, color: "#484f58", padding: "3px 6px", fontFamily: M }}>+{profile.skills.length - 6} more</span>
          )}
        </div>
      </div>

      {/* ── expanded details ─────────────────────────────────────────────────── */}
      {open && (
        <div style={{ borderTop: "1px solid #1f1f1f", padding: "18px 20px" }}>

          {/* 9-dimension score bars */}
          <Section title="Scoring breakdown">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dimensions.map((d) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 140, fontSize: 11, color: "#7d8590", fontFamily: M, flexShrink: 0 }}>{d.label}</div>
                  <Bar score={d.score} />
                  <div style={{ width: 28, fontSize: 11, color: "#484f58", textAlign: "right", fontFamily: M, flexShrink: 0 }}>{d.score}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* Strong why */}
          {strongWhy && (
            <Section title="Why this rank">
              <div style={{ fontSize: 12, color: "#7d8590", lineHeight: 1.65, fontFamily: M }}>
                <div style={{ color: "#e6edf3", marginBottom: 6 }}>{strongWhy.verdict}</div>
                {strongWhy.proof.slice(0, 2).map((p, i) => (
                  <div key={i} style={{ paddingLeft: 12, borderLeft: "1px solid #262626", marginBottom: 5, color: "#7d8590" }}>
                    {p.claim}
                    {p.artifact && <span style={{ color: "#484f58" }}> · {p.artifact}</span>}
                  </div>
                ))}
                {strongWhy.caveat && (
                  <div style={{ marginTop: 8, color: "#484f58", fontStyle: "italic" }}>
                    ⚠ {strongWhy.caveat}
                  </div>
                )}
                {strongWhy.validationQuestion && (
                  <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 5, border: "1px solid #262626", background: "#111", color: "#7d8590" }}>
                    Interview: {strongWhy.validationQuestion}
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Potential + TTP */}
          {potentialProfile && (
            <Section title="Learning potential">
              <div style={{ fontSize: 12, color: "#7d8590", fontFamily: M, marginBottom: 10 }}>
                <span style={{ color: "#e6edf3" }}>{potentialProfile.potentialHeadline}</span>
                <span style={{ color: "#484f58" }}> · {potentialProfile.potentialTier.replace(/_/g, " ")}</span>
                <span style={{ color: "#39d353", fontWeight: 600, marginLeft: 8 }}>{potentialProfile.potentialScore}/100</span>
              </div>

              {missingGaps.slice(0, 3).map((g) => (
                <div key={g.requiredSkill} style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontSize: 11, fontFamily: M }}>
                  <span style={{ color: "#e6edf3", minWidth: 120 }}>{g.requiredSkill}</span>
                  <span style={{ color: "#484f58" }}>missing</span>
                  <span style={{ color: "#7d8590" }}>·</span>
                  <span style={{ color: "#7d8590" }}>{g.ttpDisplay}</span>
                  {g.bridgeSkill && <span style={{ color: "#484f58" }}>via {g.bridgeSkill}</span>}
                </div>
              ))}

              {potentialProfile.learnerSignals.slice(0, 2).map((s, i) => (
                <div key={i} style={{ fontSize: 11, color: "#484f58", fontFamily: M, marginTop: 4 }}>
                  → {s}
                </div>
              ))}
            </Section>
          )}

          {/* Cognitive style */}
          {cognitiveStyle && (
            <Section title="Cognitive style">
              <div style={{ fontSize: 12, color: "#7d8590", fontFamily: M, lineHeight: 1.6 }}>
                <span style={{ color: "#e6edf3" }}>{cognitiveStyle.primaryStyle.replace(/_/g, " ")}</span>
                {cognitiveStyle.secondaryStyle && <span style={{ color: "#484f58" }}> + {cognitiveStyle.secondaryStyle.replace(/_/g, " ")}</span>}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#7d8590", fontFamily: M, lineHeight: 1.6 }}>
                {cognitiveStyle.cognitiveFingerprint}
              </div>
              {cognitiveStyle.commitAnalysis.bestCommitMessage && (
                <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 5, border: "1px solid #1f1f1f", background: "#0f0f0f", fontSize: 11, color: "#484f58", fontFamily: M, fontStyle: "italic", lineHeight: 1.55 }}>
                  "{cognitiveStyle.commitAnalysis.bestCommitMessage.slice(0, 160)}"
                </div>
              )}
            </Section>
          )}

          {/* Risk audit */}
          {riskAudit && riskAudit.risks.length > 0 && (
            <Section title="Risk & gaps">
              {riskAudit.blockingRisks.map((r, i) => (
                <div key={i} style={{ marginBottom: 6, padding: "7px 10px", borderRadius: 5, border: "1px solid rgba(200,70,70,0.2)", background: "rgba(200,70,70,0.04)", fontSize: 11, color: "#c85050", fontFamily: M }}>
                  BLOCKING · {r.gapStatement}
                </div>
              ))}
              {riskAudit.significantRisks.map((r, i) => (
                <div key={i} style={{ marginBottom: 5, fontSize: 11, color: "#7d8590", fontFamily: M, paddingLeft: 10, borderLeft: "1px solid #333" }}>
                  {r.gapStatement}
                  {r.validationApproach && <span style={{ color: "#484f58" }}> — probe: {r.validationApproach}</span>}
                </div>
              ))}
              {riskAudit.suggestedInterviewProbes.slice(0, 2).map((q, i) => (
                <div key={i} style={{ marginTop: 5, fontSize: 11, color: "#484f58", fontFamily: M }}>
                  Q{i + 1}: {q}
                </div>
              ))}
            </Section>
          )}

          {/* Trending contributions */}
          {trendingContributions.trendingReposContributed > 0 && (
            <Section title="Trending contributions">
              <div style={{ fontSize: 11, color: "#7d8590", fontFamily: M }}>
                {trendingContributions.highlights.slice(0, 2).map((h, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>→ {h}</div>
                ))}
              </div>
            </Section>
          )}

          {/* Fairness certificate */}
          {fairnessCertificate && (
            <Section title="Fairness audit">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: biasColor, fontFamily: M }}>
                  {fairnessCertificate.verdictEmoji} {fairnessCertificate.overallVerdict.replace(/_/g, " ")}
                </span>
                <span style={{ fontSize: 11, color: "#484f58", fontFamily: M }}>
                  CDI {fairnessCertificate.causalDisparityIndex} · stability {fairnessCertificate.stabilityRating}
                </span>
                <span style={{ fontSize: 11, color: "#484f58", fontFamily: M }}>
                  {fairnessCertificate.anonymizationStatus} PII stripped
                </span>
              </div>
              <div style={{ fontSize: 10, color: "#484f58", fontFamily: M }}>{fairnessCertificate.reportNumber}</div>
            </Section>
          )}

          {/* Transparency card */}
          {transparencyCard && (
            <Section title="What was evaluated">
              <div style={{ fontSize: 11, color: "#484f58", fontFamily: M, lineHeight: 1.65 }}>
                {transparencyCard.evaluationStatement}
              </div>
              {transparencyCard.discardedSignalReasons.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#484f58", fontFamily: M }}>
                  Excluded: {transparencyCard.discardedSignalReasons.join(" · ")}
                </div>
              )}
            </Section>
          )}

          {/* Why overlooked */}
          {hiddenScore >= 5 && (
            <Section title="Why overlooked">
              <div style={{ fontSize: 12, color: "#7d8590", fontFamily: M, lineHeight: 1.6, fontStyle: "italic" }}>
                {whyOverlooked}
              </div>
            </Section>
          )}

          {/* Links */}
          <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
            <a href={profile.github_url} target="_blank" rel="noopener noreferrer"
               style={{ fontSize: 11, color: "#484f58", fontFamily: M, textDecoration: "none" }}>
              GitHub ↗
            </a>
            {profile.socialPresence?.linkedin && (
              <a href={profile.socialPresence.linkedin.url} target="_blank" rel="noopener noreferrer"
                 style={{ fontSize: 11, color: "#484f58", fontFamily: M, textDecoration: "none" }}>
                LinkedIn ↗
              </a>
            )}
            {profile.socialPresence?.personalWebsite && (
              <a href={profile.socialPresence.personalWebsite.url} target="_blank" rel="noopener noreferrer"
                 style={{ fontSize: 11, color: "#484f58", fontFamily: M, textDecoration: "none" }}>
                Website ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
