/**
 * SKILL GRAPH
 * ─────────────────────────────────────────────────────────────────────────────
 * A directed, weighted graph of skill adjacencies.
 *
 * Core properties:
 *
 *   DIRECTED — adjacency is asymmetric.
 *     Knowing C++ makes learning Rust much easier (strong forward transfer).
 *     Knowing Rust gives you some C++ intuition but not the full picture.
 *     Edge C++→Rust has weight 1.5. Edge Rust→C++ has weight 3.0.
 *
 *   WEIGHTED by SKILL DISTANCE (not similarity).
 *     Low weight = small distance = easy to cross (adjacent skills).
 *     High weight = large distance = harder transition.
 *     Weight encodes: conceptual distance × paradigm shift penalty.
 *
 *   LAYERED — every skill belongs to domains and paradigms.
 *     Domain:   systems | web | ml | data | devops | mobile | embedded | security
 *     Paradigm: imperative | functional | declarative | concurrent | reactive
 *
 * Distance interpretation (used in TTP estimation):
 *   < 1.0  → trivial: same syntax family, different API surface
 *   1–2    → easy: same paradigm, different toolchain
 *   2–3    → moderate: similar paradigm, different mental model
 *   3–4    → hard: different paradigm or domain
 *   4–5    → very hard: different paradigm AND domain
 *   > 5    → major transition: completely different world
 *
 * The graph is static domain knowledge + dynamically enriched from
 * the candidate's own trajectory (their personal adjacency history).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillDomain =
  | "systems"       // C, C++, Rust, Zig, assembly
  | "web_frontend"  // HTML, CSS, JS, TS, React, Vue, Svelte
  | "web_backend"   // Node, Django, Rails, FastAPI, Go, Java/Spring
  | "ml_research"   // PyTorch, JAX, paper implementations
  | "ml_infra"      // ONNX, TVM, Triton, model serving
  | "data"          // SQL, Spark, Pandas, dbt, Airflow
  | "devops"        // Docker, K8s, Terraform, CI/CD
  | "mobile"        // Swift, Kotlin, React Native, Flutter
  | "embedded"      // C, Rust no_std, RTOS, firmware
  | "security"      // cryptography, reverse engineering, fuzzing
  | "compiler"      // LLVM, parser combinators, IR, codegen
  | "database"      // storage engines, query planners, indexes
  | "distributed"   // consensus, CRDT, distributed systems
  | "unknown";

export type Paradigm =
  | "imperative"
  | "functional"
  | "declarative"
  | "concurrent"
  | "reactive"
  | "object_oriented"
  | "systems_level"   // manual memory, ownership, lifetimes
  | "type_driven"     // type systems, proof assistants
  | "data_flow";

export interface SkillNode {
  id: string;               // canonical name (lowercase, normalized)
  displayName: string;
  aliases: string[];        // alternate names ("js" → "javascript")
  domain: SkillDomain;
  paradigms: Paradigm[];
  /** How long it typically takes to reach PROFICIENCY from scratch (weeks) */
  intrinsicDifficulty: number;
  /** Whether this is a foundational skill (prerequisite for many others) */
  isFoundational: boolean;
  /** Broad technology category */
  category: "language" | "framework" | "tool" | "paradigm" | "domain";
}

export interface SkillEdge {
  from: string;   // skill ID
  to: string;     // skill ID
  /** Distance — lower = easier to transition */
  distance: number;
  /** What percentage of knowledge transfers (0–1) */
  transferPotential: number;
  /** The specific things that transfer */
  whatTransfers: string[];
  /** The main things that still need to be learned */
  whatDoesnt: string[];
}

export interface SkillPath {
  from: string;
  to: string;
  /** Ordered list of skills to traverse */
  path: string[];
  /** Total distance along the path */
  totalDistance: number;
  /** Whether there's a direct edge */
  isDirect: boolean;
  /** The bottleneck skill (hardest transition in the path) */
  bottleneck: string | null;
  /** What percentage of required knowledge already transfers */
  overallTransferPotential: number;
}

// ─── Skill Node Registry ──────────────────────────────────────────────────────

export const SKILL_NODES: Record<string, SkillNode> = {
  // ── Systems / Low-level ───────────────────────────────────────────────────
  c: {
    id: "c", displayName: "C", aliases: [],
    domain: "systems", paradigms: ["imperative", "systems_level"],
    intrinsicDifficulty: 16, isFoundational: true, category: "language",
  },
  cpp: {
    id: "cpp", displayName: "C++", aliases: ["c++"],
    domain: "systems", paradigms: ["imperative", "object_oriented", "systems_level"],
    intrinsicDifficulty: 20, isFoundational: true, category: "language",
  },
  rust: {
    id: "rust", displayName: "Rust", aliases: [],
    domain: "systems", paradigms: ["systems_level", "functional", "concurrent"],
    intrinsicDifficulty: 22, isFoundational: false, category: "language",
  },
  zig: {
    id: "zig", displayName: "Zig", aliases: [],
    domain: "systems", paradigms: ["imperative", "systems_level"],
    intrinsicDifficulty: 14, isFoundational: false, category: "language",
  },
  go: {
    id: "go", displayName: "Go", aliases: ["golang"],
    domain: "web_backend", paradigms: ["imperative", "concurrent"],
    intrinsicDifficulty: 8, isFoundational: false, category: "language",
  },

  // ── Web Frontend ──────────────────────────────────────────────────────────
  javascript: {
    id: "javascript", displayName: "JavaScript", aliases: ["js"],
    domain: "web_frontend", paradigms: ["imperative", "functional", "reactive"],
    intrinsicDifficulty: 8, isFoundational: true, category: "language",
  },
  typescript: {
    id: "typescript", displayName: "TypeScript", aliases: ["ts"],
    domain: "web_frontend", paradigms: ["imperative", "type_driven"],
    intrinsicDifficulty: 4, isFoundational: false, category: "language",
  },
  react: {
    id: "react", displayName: "React", aliases: ["reactjs"],
    domain: "web_frontend", paradigms: ["declarative", "reactive"],
    intrinsicDifficulty: 8, isFoundational: false, category: "framework",
  },
  vue: {
    id: "vue", displayName: "Vue", aliases: ["vuejs"],
    domain: "web_frontend", paradigms: ["declarative", "reactive"],
    intrinsicDifficulty: 6, isFoundational: false, category: "framework",
  },
  svelte: {
    id: "svelte", displayName: "Svelte", aliases: [],
    domain: "web_frontend", paradigms: ["declarative", "reactive"],
    intrinsicDifficulty: 5, isFoundational: false, category: "framework",
  },

  // ── Python Ecosystem ──────────────────────────────────────────────────────
  python: {
    id: "python", displayName: "Python", aliases: ["py"],
    domain: "ml_research", paradigms: ["imperative", "object_oriented", "functional"],
    intrinsicDifficulty: 6, isFoundational: true, category: "language",
  },
  pytorch: {
    id: "pytorch", displayName: "PyTorch", aliases: [],
    domain: "ml_research", paradigms: ["imperative", "data_flow"],
    intrinsicDifficulty: 12, isFoundational: false, category: "framework",
  },
  jax: {
    id: "jax", displayName: "JAX", aliases: [],
    domain: "ml_research", paradigms: ["functional", "data_flow"],
    intrinsicDifficulty: 14, isFoundational: false, category: "framework",
  },
  tensorflow: {
    id: "tensorflow", displayName: "TensorFlow", aliases: ["tf"],
    domain: "ml_research", paradigms: ["declarative", "data_flow"],
    intrinsicDifficulty: 14, isFoundational: false, category: "framework",
  },
  numpy: {
    id: "numpy", displayName: "NumPy", aliases: [],
    domain: "data", paradigms: ["imperative", "data_flow"],
    intrinsicDifficulty: 4, isFoundational: true, category: "framework",
  },

  // ── ML Infrastructure ─────────────────────────────────────────────────────
  onnx: {
    id: "onnx", displayName: "ONNX", aliases: [],
    domain: "ml_infra", paradigms: ["declarative", "data_flow"],
    intrinsicDifficulty: 10, isFoundational: false, category: "tool",
  },
  triton: {
    id: "triton", displayName: "Triton", aliases: [],
    domain: "ml_infra", paradigms: ["systems_level", "concurrent"],
    intrinsicDifficulty: 16, isFoundational: false, category: "framework",
  },
  cuda: {
    id: "cuda", displayName: "CUDA", aliases: [],
    domain: "ml_infra", paradigms: ["systems_level", "concurrent"],
    intrinsicDifficulty: 20, isFoundational: false, category: "framework",
  },

  // ── Backend / Distributed ─────────────────────────────────────────────────
  java: {
    id: "java", displayName: "Java", aliases: [],
    domain: "web_backend", paradigms: ["object_oriented", "imperative"],
    intrinsicDifficulty: 12, isFoundational: true, category: "language",
  },
  kotlin: {
    id: "kotlin", displayName: "Kotlin", aliases: [],
    domain: "web_backend", paradigms: ["object_oriented", "functional"],
    intrinsicDifficulty: 8, isFoundational: false, category: "language",
  },
  scala: {
    id: "scala", displayName: "Scala", aliases: [],
    domain: "distributed", paradigms: ["functional", "object_oriented"],
    intrinsicDifficulty: 16, isFoundational: false, category: "language",
  },
  elixir: {
    id: "elixir", displayName: "Elixir", aliases: [],
    domain: "distributed", paradigms: ["functional", "concurrent"],
    intrinsicDifficulty: 12, isFoundational: false, category: "language",
  },
  haskell: {
    id: "haskell", displayName: "Haskell", aliases: [],
    domain: "compiler", paradigms: ["functional", "type_driven"],
    intrinsicDifficulty: 28, isFoundational: false, category: "language",
  },
  ocaml: {
    id: "ocaml", displayName: "OCaml", aliases: [],
    domain: "compiler", paradigms: ["functional", "type_driven"],
    intrinsicDifficulty: 20, isFoundational: false, category: "language",
  },

  // ── Data & Analytics ──────────────────────────────────────────────────────
  sql: {
    id: "sql", displayName: "SQL", aliases: [],
    domain: "data", paradigms: ["declarative"],
    intrinsicDifficulty: 6, isFoundational: true, category: "language",
  },
  spark: {
    id: "spark", displayName: "Apache Spark", aliases: [],
    domain: "data", paradigms: ["functional", "data_flow"],
    intrinsicDifficulty: 14, isFoundational: false, category: "framework",
  },

  // ── Infra ─────────────────────────────────────────────────────────────────
  kubernetes: {
    id: "kubernetes", displayName: "Kubernetes", aliases: ["k8s"],
    domain: "devops", paradigms: ["declarative"],
    intrinsicDifficulty: 14, isFoundational: false, category: "tool",
  },
  terraform: {
    id: "terraform", displayName: "Terraform", aliases: [],
    domain: "devops", paradigms: ["declarative"],
    intrinsicDifficulty: 8, isFoundational: false, category: "tool",
  },

  // ── Compiler / PL ─────────────────────────────────────────────────────────
  llvm: {
    id: "llvm", displayName: "LLVM", aliases: [],
    domain: "compiler", paradigms: ["systems_level", "imperative"],
    intrinsicDifficulty: 24, isFoundational: false, category: "framework",
  },
  webassembly: {
    id: "webassembly", displayName: "WebAssembly", aliases: ["wasm"],
    domain: "compiler", paradigms: ["systems_level", "declarative"],
    intrinsicDifficulty: 16, isFoundational: false, category: "paradigm",
  },
};

// ─── Edge Registry ────────────────────────────────────────────────────────────
// Directed edges: from → to with transfer potential.
// Only the strongest/most common transitions are listed.
// Dijkstra fills in multi-hop paths automatically.

export const SKILL_EDGES: SkillEdge[] = [
  // ── C/C++ family ──────────────────────────────────────────────────────────
  { from: "c", to: "cpp", distance: 1.2, transferPotential: 0.85,
    whatTransfers: ["memory model", "pointers", "stack/heap", "compilation"],
    whatDoesnt: ["OOP patterns", "templates", "RAII", "STL"] },
  { from: "cpp", to: "c", distance: 1.5, transferPotential: 0.75,
    whatTransfers: ["memory management fundamentals", "compilation mental model"],
    whatDoesnt: ["C-specific idioms", "portability constraints"] },
  { from: "cpp", to: "rust", distance: 1.8, transferPotential: 0.70,
    whatTransfers: ["manual memory thinking", "zero-cost abstraction goals", "performance intuition", "systems mental model"],
    whatDoesnt: ["ownership/borrowing rules", "lifetime syntax", "trait system", "error handling via Result"] },
  { from: "c", to: "rust", distance: 2.2, transferPotential: 0.60,
    whatTransfers: ["memory awareness", "low-level thinking"],
    whatDoesnt: ["ownership model", "type system", "async patterns", "idiomatic Rust"] },
  { from: "cpp", to: "zig", distance: 1.5, transferPotential: 0.70,
    whatTransfers: ["manual memory", "performance mindset", "compile-time thinking"],
    whatDoesnt: ["comptime specifics", "Zig error handling", "no hidden allocations discipline"] },
  { from: "c", to: "zig", distance: 1.2, transferPotential: 0.80,
    whatTransfers: ["manual memory", "low-level OS interaction", "pointer arithmetic"],
    whatDoesnt: ["comptime", "Zig's unique error handling", "import system"] },
  { from: "rust", to: "cpp", distance: 2.5, transferPotential: 0.55,
    whatTransfers: ["mental model of memory safety", "RAII intuition"],
    whatDoesnt: ["UB tolerance", "implicit copy semantics", "older C++ patterns"] },
  { from: "rust", to: "webassembly", distance: 1.4, transferPotential: 0.80,
    whatTransfers: ["no_std experience", "binary size awareness", "memory safety guarantees"],
    whatDoesnt: ["WASI APIs", "component model", "JS interop layer"] },
  { from: "c", to: "webassembly", distance: 2.0, transferPotential: 0.60,
    whatTransfers: ["memory model", "no garbage collector thinking"],
    whatDoesnt: ["WASI", "linear memory constraints", "browser APIs"] },

  // ── Python / ML ───────────────────────────────────────────────────────────
  { from: "python", to: "numpy", distance: 0.8, transferPotential: 0.90,
    whatTransfers: ["Python syntax", "scripting mental model"],
    whatDoesnt: ["vectorized thinking", "broadcasting rules", "memory layout awareness"] },
  { from: "numpy", to: "pytorch", distance: 1.5, transferPotential: 0.70,
    whatTransfers: ["tensor operations", "vectorized thinking", "GPU intuition beginnings"],
    whatDoesnt: ["autograd", "computation graph", "training loops", "model architecture"] },
  { from: "pytorch", to: "jax", distance: 2.0, transferPotential: 0.65,
    whatTransfers: ["tensor thinking", "ML model training intuition", "GPU programming"],
    whatDoesnt: ["functional purity requirement", "jit/vmap/grad transforms", "stateless design"] },
  { from: "tensorflow", to: "pytorch", distance: 1.8, transferPotential: 0.70,
    whatTransfers: ["ML training loop concepts", "gradient descent intuition"],
    whatDoesnt: ["eager execution model", "Pythonic API", "autograd design"] },
  { from: "pytorch", to: "onnx", distance: 1.5, transferPotential: 0.75,
    whatTransfers: ["model architecture knowledge", "tensor understanding"],
    whatDoesnt: ["export process", "operator coverage", "runtime embedding"] },
  { from: "pytorch", to: "triton", distance: 2.5, transferPotential: 0.55,
    whatTransfers: ["GPU awareness", "kernel concepts", "performance intuition"],
    whatDoesnt: ["kernel writing syntax", "memory coalescing", "warp-level programming"] },
  { from: "cuda", to: "triton", distance: 1.5, transferPotential: 0.75,
    whatTransfers: ["GPU programming model", "warp/block/grid", "memory hierarchy"],
    whatDoesnt: ["Triton-specific syntax", "tiled matmul patterns", "Python JIT compilation"] },
  { from: "cpp", to: "cuda", distance: 2.0, transferPotential: 0.65,
    whatTransfers: ["manual memory management", "performance sensitivity", "pointer thinking"],
    whatDoesnt: ["GPU memory hierarchy", "thread divergence", "warp synchronization"] },
  { from: "python", to: "rust", distance: 3.8, transferPotential: 0.25,
    whatTransfers: ["algorithmic thinking", "problem decomposition"],
    whatDoesnt: ["ownership model", "type system", "everything about systems programming"] },

  // ── Web Frontend ──────────────────────────────────────────────────────────
  { from: "javascript", to: "typescript", distance: 0.8, transferPotential: 0.95,
    whatTransfers: ["all JavaScript knowledge", "ecosystem familiarity"],
    whatDoesnt: ["type annotations", "generics", "strict null checks", "type narrowing"] },
  { from: "javascript", to: "react", distance: 1.5, transferPotential: 0.70,
    whatTransfers: ["DOM manipulation concepts", "async patterns", "event handling"],
    whatDoesnt: ["component mental model", "hooks", "virtual DOM", "JSX"] },
  { from: "react", to: "vue", distance: 1.2, transferPotential: 0.75,
    whatTransfers: ["component-based thinking", "reactivity concepts", "SPA patterns"],
    whatDoesnt: ["Options API vs Composition API", "Vue-specific directives", "template syntax"] },
  { from: "vue", to: "react", distance: 1.3, transferPotential: 0.72,
    whatTransfers: ["reactivity model", "component lifecycle", "SPA architecture"],
    whatDoesnt: ["hooks mental model", "JSX", "fiber architecture"] },
  { from: "react", to: "svelte", distance: 1.4, transferPotential: 0.68,
    whatTransfers: ["component thinking", "reactivity principles"],
    whatDoesnt: ["compile-time reactivity", "no virtual DOM", "Svelte store"] },

  // ── Backend languages ─────────────────────────────────────────────────────
  { from: "java", to: "kotlin", distance: 0.8, transferPotential: 0.90,
    whatTransfers: ["JVM mental model", "type system", "OOP patterns", "ecosystem"],
    whatDoesnt: ["coroutines", "null safety", "data classes", "extension functions"] },
  { from: "java", to: "scala", distance: 2.5, transferPotential: 0.55,
    whatTransfers: ["JVM familiarity", "OOP foundation"],
    whatDoesnt: ["functional programming", "type class pattern", "for-comprehensions"] },
  { from: "python", to: "elixir", distance: 3.0, transferPotential: 0.40,
    whatTransfers: ["dynamic typing comfort", "scripting intuition"],
    whatDoesnt: ["actor model", "immutability", "pattern matching", "OTP"] },
  { from: "go", to: "rust", distance: 2.8, transferPotential: 0.50,
    whatTransfers: ["systems-adjacent thinking", "concurrency awareness", "compiled language mental model"],
    whatDoesnt: ["ownership/borrowing", "zero-cost abstractions", "no GC", "lifetime annotations"] },
  { from: "go", to: "kubernetes", distance: 1.5, transferPotential: 0.70,
    whatTransfers: ["concurrency patterns", "server programming", "CLI tooling"],
    whatDoesnt: ["K8s API", "operator pattern", "YAML configuration", "controller-manager loop"] },

  // ── Functional / PL ───────────────────────────────────────────────────────
  { from: "haskell", to: "rust", distance: 2.2, transferPotential: 0.65,
    whatTransfers: ["type-driven development", "functional composition", "algebraic data types"],
    whatDoesnt: ["ownership model", "imperative patterns", "systems-level thinking"] },
  { from: "haskell", to: "ocaml", distance: 1.5, transferPotential: 0.72,
    whatTransfers: ["type theory intuition", "functional patterns", "algebraic data types"],
    whatDoesnt: ["OCaml module system", "mutable state patterns", "compilation model"] },
  { from: "rust", to: "haskell", distance: 3.0, transferPotential: 0.45,
    whatTransfers: ["type system depth", "algebraic data type thinking"],
    whatDoesnt: ["lazy evaluation", "monad composition", "type classes at depth", "pure FP discipline"] },

  // ── Compiler / WASM ───────────────────────────────────────────────────────
  { from: "cpp", to: "llvm", distance: 2.0, transferPotential: 0.65,
    whatTransfers: ["compilation mental model", "IR concepts", "optimization awareness"],
    whatDoesnt: ["LLVM IR syntax", "pass infrastructure", "target-specific backend"] },
  { from: "haskell", to: "llvm", distance: 2.5, transferPotential: 0.55,
    whatTransfers: ["compiler theory", "type-driven compilation"],
    whatDoesnt: ["imperative IR", "SSA form", "register allocation"] },
  { from: "llvm", to: "webassembly", distance: 1.8, transferPotential: 0.68,
    whatTransfers: ["IR design thinking", "compilation target understanding"],
    whatDoesnt: ["WASM binary format", "WASI interface types", "component model"] },
];

// ─── Alias Resolution ─────────────────────────────────────────────────────────

const ALIAS_MAP = new Map<string, string>();
for (const [id, node] of Object.entries(SKILL_NODES)) {
  ALIAS_MAP.set(id, id);
  for (const alias of node.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), id);
  }
}

export function resolveSkillId(name: string): string | null {
  const lower = name.toLowerCase().replace(/[^a-z0-9+#]/g, "");
  return ALIAS_MAP.get(lower) ?? null;
}

// ─── Adjacency Map Builder ────────────────────────────────────────────────────

type AdjMap = Map<string, Map<string, SkillEdge>>;

function buildAdjacencyMap(): AdjMap {
  const map: AdjMap = new Map();
  for (const node of Object.keys(SKILL_NODES)) {
    map.set(node, new Map());
  }
  for (const edge of SKILL_EDGES) {
    if (map.has(edge.from)) {
      map.get(edge.from)!.set(edge.to, edge);
    }
  }
  return map;
}

const ADJ_MAP = buildAdjacencyMap();

// ─── Dijkstra's Shortest Path ─────────────────────────────────────────────────

/**
 * findShortestPath — Dijkstra's on the skill graph.
 *
 * Finds the shortest-distance path between two skills.
 * "Shortest distance" = easiest learning transition.
 *
 * Works even if the skills aren't directly connected —
 * traverses intermediate skills as stepping stones.
 */
export function findShortestPath(
  fromSkill: string,
  toSkill: string
): SkillPath | null {
  const from = resolveSkillId(fromSkill);
  const to = resolveSkillId(toSkill);

  if (!from || !to) return null;
  if (from === to) {
    return { from, to, path: [from], totalDistance: 0, isDirect: true, bottleneck: null, overallTransferPotential: 1.0 };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const unvisited = new Set<string>(Object.keys(SKILL_NODES));

  for (const node of unvisited) dist.set(node, Infinity);
  dist.set(from, 0);
  prev.set(from, null);

  while (unvisited.size > 0) {
    // Find unvisited node with smallest distance
    let u: string | null = null;
    let uDist = Infinity;
    for (const node of unvisited) {
      const d = dist.get(node) ?? Infinity;
      if (d < uDist) { uDist = d; u = node; }
    }

    if (!u || uDist === Infinity) break;
    if (u === to) break;

    unvisited.delete(u);

    const neighbors = ADJ_MAP.get(u);
    if (!neighbors) continue;

    for (const [v, edge] of neighbors) {
      if (!unvisited.has(v)) continue;
      const alt = uDist + edge.distance;
      if (alt < (dist.get(v) ?? Infinity)) {
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }

  if ((dist.get(to) ?? Infinity) === Infinity) return null;

  // Reconstruct path
  const path: string[] = [];
  let current: string | null = to;
  while (current !== null) {
    path.unshift(current);
    current = prev.get(current) ?? null;
  }

  const totalDistance = dist.get(to) ?? Infinity;
  const isDirect = path.length === 2;

  // Find bottleneck (hardest single hop)
  let bottleneck: string | null = null;
  let maxHop = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = ADJ_MAP.get(path[i])?.get(path[i + 1]);
    if (edge && edge.distance > maxHop) {
      maxHop = edge.distance;
      bottleneck = `${path[i]} → ${path[i + 1]}`;
    }
  }

  // Overall transfer potential = product of transfer potentials along path
  let overallTransfer = 1.0;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = ADJ_MAP.get(path[i])?.get(path[i + 1]);
    if (edge) overallTransfer *= edge.transferPotential;
  }

  return { from, to, path, totalDistance, isDirect, bottleneck, overallTransferPotential: overallTransfer };
}

/**
 * findAllPaths — from a SET of skills to a target skill.
 * Returns the best (shortest) path from any of the candidate's skills.
 */
export function findBestPathFromSet(
  candidateSkills: string[],
  targetSkill: string
): { path: SkillPath; sourceSkill: string } | null {
  let best: { path: SkillPath; sourceSkill: string } | null = null;

  for (const skill of candidateSkills) {
    const path = findShortestPath(skill, targetSkill);
    if (path && (!best || path.totalDistance < best.path.totalDistance)) {
      best = { path, sourceSkill: skill };
    }
  }

  return best;
}

/**
 * getDirectEdge — retrieves a direct adjacency edge if one exists.
 */
export function getDirectEdge(from: string, to: string): SkillEdge | null {
  const fromId = resolveSkillId(from);
  const toId = resolveSkillId(to);
  if (!fromId || !toId) return null;
  return ADJ_MAP.get(fromId)?.get(toId) ?? null;
}

/**
 * getSkillNode — retrieves node metadata for a skill.
 */
export function getSkillNode(skill: string): SkillNode | null {
  const id = resolveSkillId(skill);
  return id ? (SKILL_NODES[id] ?? null) : null;
}

/**
 * computeDomainOverlap — what fraction of required skills share a domain
 * with skills the candidate already knows.
 */
export function computeDomainOverlap(
  candidateSkills: string[],
  requiredSkills: string[]
): number {
  const candidateDomains = new Set<string>();
  for (const s of candidateSkills) {
    const node = getSkillNode(s);
    if (node) candidateDomains.add(node.domain);
  }

  if (requiredSkills.length === 0) return 0;
  const overlapping = requiredSkills.filter((s) => {
    const node = getSkillNode(s);
    return node && candidateDomains.has(node.domain);
  });

  return overlapping.length / requiredSkills.length;
}
