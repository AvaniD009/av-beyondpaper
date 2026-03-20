"use client";

const CHIPS = [
  "Low-latency trading systems engineers",
  "Rust systems programmers",
  "Embedded systems specialists",
  "Cryptography specialists",
  "GPU kernel developers",
  "WASM runtime builders",
  "Distributed consensus engineers",
];

export default function ExampleChips({ onSelect }: { onSelect: (text: string) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 18 }}>
      {CHIPS.map((c) => (
        <button
          key={c}
          onClick={() => onSelect(c)}
          className="chip"
        >
          {c}
        </button>
      ))}
    </div>
  );
}
