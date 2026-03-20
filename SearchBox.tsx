"use client";
import { useRef, useEffect } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export default function SearchBox({ value, onChange, onSearch, onCancel, isLoading }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!isLoading && value.trim()) onSearch(); }
    if (e.key === "Escape" && isLoading) onCancel();
  };

  return (
    <div style={{
      width: "100%", borderRadius: 10,
      border: `1px solid ${isLoading ? "rgba(57,211,83,0.28)" : "#262626"}`,
      background: "#141414", overflow: "hidden",
      transition: "border-color 0.2s",
      boxShadow: isLoading ? "0 0 0 1px rgba(57,211,83,0.1), 0 4px 20px rgba(0,0,0,0.5)" : "0 2px 10px rgba(0,0,0,0.5)",
    }}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Who are you looking for?"
        rows={1}
        disabled={isLoading}
        style={{
          width: "100%", background: "transparent", border: "none", outline: "none", resize: "none",
          padding: "20px 20px 0 20px", color: "#e6edf3",
          fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
          fontSize: 13, lineHeight: 1.65, caretColor: "#39d353", minHeight: 58,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px 14px 20px" }}>
        <span style={{ color: "#484f58", fontSize: 12, fontFamily: "inherit" }}>
          <strong style={{ color: "#7d8590", fontWeight: 500 }}>enter</strong> to search,&nbsp;&nbsp;
          <strong style={{ color: "#7d8590", fontWeight: 500 }}>shift + enter</strong> for new line
        </span>
        {isLoading ? (
          <button onClick={onCancel} style={{
            padding: "5px 12px", borderRadius: 6, border: "1px solid rgba(57,211,83,0.3)",
            background: "transparent", color: "#39d353",
            fontFamily: "inherit", fontSize: 11, cursor: "pointer",
          }}>cancel</button>
        ) : (
          <button onClick={onSearch} disabled={!value.trim()} style={{
            width: 34, height: 34, borderRadius: 7,
            border: "1px solid #333", background: "#1c1c1c",
            color: value.trim() ? "#e6edf3" : "#484f58",
            cursor: value.trim() ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, transition: "color 0.15s",
          }}>→</button>
        )}
      </div>
    </div>
  );
}
