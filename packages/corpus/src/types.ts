/**
 * Corpus data model.
 *
 * Three layers, deliberately separated so a parser change never forces a refetch and a
 * normalization change never forces a reparse:
 *
 *   RawSolve     — what the page said, with minimal interpretation
 *   SolveRecord  — RawSolve plus method classification, segmentation, and verification
 *   PhaseStats   — the distributions A3 scores against
 */
import type { Move } from "@cubing-companion/engine";

/** Canonical CFOP phases. A segment can cover several (an xcross is cross + first pair). */
export const Phase = {
  Inspection: "inspection",
  Cross: "cross",
  F2L1: "f2l1",
  F2L2: "f2l2",
  F2L3: "f2l3",
  F2L4: "f2l4",
  /**
   * Standalone edge orientation, as used in EO+ZBLL solves. Kept distinct from OLL: it is
   * only part of orientation, and folding it into the OLL distribution would contaminate
   * that baseline with a cheaper step.
   */
  EO: "eo",
  OLL: "oll",
  PLL: "pll",
  AUF: "auf",
  /** Last layer solved in one look (ZBLL, 1LLL) — neither OLL nor PLL alone. */
  LastLayer: "last-layer",
  Unknown: "unknown",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/** The four F2L slots in order, for convenience. */
export const F2L_PHASES: readonly Phase[] = [
  Phase.F2L1,
  Phase.F2L2,
  Phase.F2L3,
  Phase.F2L4,
];

/** Solving method, inferred from the reconstructor's phase labels. */
export const Method = {
  CFOP: "CFOP",
  Roux: "Roux",
  ZZ: "ZZ",
  Petrus: "Petrus",
  Other: "Other",
  Unknown: "Unknown",
} as const;
export type Method = (typeof Method)[keyof typeof Method];

/**
 * One row of the published stats table.
 *
 * Reconstructions carry no per-move timestamps, so this table is the corpus's only source
 * of timing. Without it there is no way to compute a phase duration from a reconstruction,
 * and A3's time-based percentiles would be impossible.
 */
export interface StatGroup {
  readonly time: number | null;
  /** Percentage of total solve time, as published. */
  readonly split: number | null;
  /** Slice turn metric. */
  readonly stm: number | null;
  /** Slice turns per second. */
  readonly stps: number | null;
  /** Execution turn metric. */
  readonly etm: number | null;
  /** Execution turns per second. */
  readonly etps: number | null;
}

/**
 * Published stats, keyed by the groupings reco.nz uses.
 *
 * Note these are coarser than the move annotations: timing exists at F2L/LL/Cross+1/OLS/PLL
 * granularity, while move segmentation is available per individual pair.
 */
export interface SolveStats {
  readonly [group: string]: StatGroup;
}

/** A solve exactly as the page presented it. */
export interface RawSolve {
  readonly id: number;
  readonly url: string;
  readonly solver: string;
  readonly solverSlug: string | null;
  readonly timeSeconds: number | null;
  /** "3x3", "OH", "7x7", ... as written in the page title. */
  readonly event: string | null;
  /** ISO date, when the page gives one. */
  readonly date: string | null;
  readonly competition: string | null;
  /** Record tags such as "WR" or "NR". */
  readonly tags: readonly string[];
  readonly reconstructor: string | null;
  readonly reconstructorSlug: string | null;
  readonly hardware: string | null;
  readonly scramble: string;
  /** The solution with the reconstructor's `// label` annotations preserved. */
  readonly solution: string;
  readonly stats: SolveStats | null;
}

/** One annotated line of a solution. */
export interface Segment {
  /** The reconstructor's label, verbatim. */
  readonly rawLabel: string;
  /** Canonical phases this segment covers; several when the label merges them. */
  readonly phases: readonly Phase[];
  /** True when one label covers more than one phase (`3rd/4th pairs`, `xcross`). */
  readonly merged: boolean;
  readonly moves: readonly Move[];
  /** Non-rotation moves — the slice turn metric for this segment. */
  readonly turns: number;
  /** Whole-cube rotations (x/y/z) in this segment. */
  readonly rotations: number;
}

/** Why a solve was rejected, when it was. */
export type RejectionReason =
  | "not-3x3"
  | "empty-reconstruction"
  | "not-cfop"
  | "unparseable-notation"
  | "does-not-solve"
  | "no-segments";

/**
 * Segmentation quality, which governs what a solve may be used for.
 *
 * `clean` solves are the ones per-phase distributions can be built from; `merged` solves
 * still contribute to whole-solve statistics.
 */
export type Quality = "clean" | "merged" | "partial";

/** A parsed, classified, verified solve. */
export interface SolveRecord extends RawSolve {
  readonly method: Method;
  readonly segments: readonly Segment[];
  /** Scramble + solution applied to a solved cube returns to solved. */
  readonly verified: boolean;
  /**
   * An unambiguous spacing typo was repaired before parsing (see `repairSpacing`).
   * Recorded so modifications to source data are always auditable rather than silent.
   */
  readonly repaired: boolean;
  readonly quality: Quality;
  /** Total non-rotation moves across all segments. */
  readonly totalTurns: number;
  readonly totalRotations: number;
}

/** A solve that did not make it into the corpus, kept so the funnel is auditable. */
export interface Rejection {
  readonly id: number;
  readonly reason: RejectionReason;
  readonly detail: string;
}
