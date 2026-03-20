"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import SearchBox from "@/components/SearchBox";
import ExampleChips from "@/components/ExampleChips";
import CandidateCard from "@/components/CandidateCard";
import type { SearchResult, SearchProgress } from "@/lib/pipeline";

const TYPEWRITER_MS = 14;

export default function Home() {
  const [query, setQuery]           = useState("");
  const [result, setResult]         = useState<SearchResult | null>(null);
  const [progress, setProgress]     = useState<SearchProgress | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const abortRef  = useRef<AbortController | null>(null);
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || isSearching) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsSearching(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "analyzing_query", message: "Understanding query…" });

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: abortRef.current.signal,
      });
      if (!res.body) throw new Error("No stream");
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const p = JSON.parse(line.slice(6));
          if (p.type === "progress") setProgress(p);
          else if (p.type === "result") { setResult(p.data); setProgress(null); }
          else if (p.type === "error")  { setError(p.message); setProgress(null); }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return;
      setError("Search failed. Please try again.");
      setProgress(null);
    } finally {
      setIsSearching(false);
    }
  }, [isSearching]);

  // Chip typewriter → auto-search
  const typeIn = useCallback((text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setQuery("");
    setResult(null);
    setError(null);
    let i = 0;
    const tick = () => {
      i++;
      setQuery(text.slice(0, i));
      if (i < text.length) timerRef.current = setTimeout(tick, TYPEWRITER_MS);
      else setTimeout(() => doSearch(text), 280);
    };
    timerRef.current = setTimeout(tick, TYPEWRITER_MS);
  }, [doSearch]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsSearching(false);
    setProgress(null);
  }, []);

  const hasResults = !!(result && result.results.length > 0);
  const showHero   = !hasResults && !isSearching && !progress;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "var(--mono)" }}>

      {/* ── Main column ── */}
      <div style={{
        width: "100%", maxWidth: 740, padding: "0 24px",
        paddingTop: hasResults ? 40 : "20vh",
        transition: "padding-top 0.45s cubic-bezier(0.16,1,0.3,1)",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 0,
      }}>

        {/* BP logo + tagline */}
        {showHero && (
          <>
            <div className="anim-up" style={{ marginBottom: 20 }}>
              <span style={{ fontSize: 52, fontWeight: 700, color: "#39d353", letterSpacing: "-0.04em", lineHeight: 1, fontFamily: "var(--mono)" }}>
                BP
              </span>
            </div>
            <p className="anim-up-1" style={{ color: "#7d8590", fontSize: 13, letterSpacing: "0.01em", marginBottom: 28, textAlign: "center" }}>
              Find engineers and scientists shaping your domain
            </p>
          </>
        )}

        {/* Search box */}
        <div className={showHero ? "anim-up-2" : ""} style={{ width: "100%" }}>
          <SearchBox
            value={query}
            onChange={setQuery}
            onSearch={() => doSearch(query)}
            onCancel={cancel}
            isLoading={isSearching}
          />
        </div>

        {/* Chips */}
        {showHero && (
          <div className="anim-up-3">
            <ExampleChips onSelect={typeIn} />
          </div>
        )}

        {/* Progress */}
        {progress && (
          <div className="anim-in" style={{ width: "100%", marginTop: 20, display: "flex", alignItems: "center", gap: 10, color: "#7d8590", fontSize: 12, padding: "10px 0" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#39d353", display: "inline-block", flexShrink: 0, animation: "bp-pulse 1.4s ease infinite" }} />
            {progress.message}
            {progress.candidatesFound !== undefined && (
              <span style={{ color: "#484f58" }}>
                — {progress.candidatesFound} found
                {progress.candidatesAnalyzed !== undefined && `, ${progress.candidatesAnalyzed} deep-analyzed`}
              </span>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="anim-in" style={{ width: "100%", marginTop: 14, padding: "9px 13px", borderRadius: 7, border: "1px solid rgba(200,70,70,0.25)", background: "rgba(200,70,70,0.06)", color: "#c85050", fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Query upgrade */}
        {result?.query.rewrite && result.query.rewrite.originalInput !== result.query.rewrite.expertQuery && (
          <div className="anim-in" style={{ width: "100%", marginTop: 14, padding: "9px 13px", borderRadius: 7, border: "1px solid #1f1f1f", background: "#111", fontSize: 12, color: "#484f58", display: "flex", gap: 6 }}>
            <span>interpreted as</span>
            <span style={{ color: "#e6edf3" }}>{result.query.rewrite.expertQuery}</span>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      {hasResults && result && (
        <div className="anim-in" style={{ width: "100%", maxWidth: 740, padding: "18px 24px 80px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#484f58", fontSize: 11, marginBottom: 14, paddingLeft: 2 }}>
            <span>{result.results.length} results · {result.totalCandidatesDiscovered} discovered · {result.totalCandidatesAnalyzed} analyzed</span>
            <span>{(result.searchDurationMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {result.results.map((r, i) => (
              <CandidateCard key={r.profile.username} result={r} rank={i + 1} />
            ))}
          </div>
        </div>
      )}

      {result && result.results.length === 0 && (
        <div className="anim-in" style={{ marginTop: 40, color: "#484f58", fontSize: 12 }}>
          No candidates found. Try broadening the query.
        </div>
      )}

      <style>{`
        @keyframes bp-pulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.4; transform:scale(0.8); }
        }
      `}</style>
    </div>
  );
}
