/**
 * Segmentation data model.
 */
import type { Face, Move } from "@cubing-companion/engine";

export const Phase = {
  Cross: "cross",
  F2L1: "f2l1",
  F2L2: "f2l2",
  F2L3: "f2l3",
  F2L4: "f2l4",
  OLL: "oll",
  PLL: "pll",
  AUF: "auf",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export const PHASE_ORDER: readonly Phase[] = [
  Phase.Cross,
  Phase.F2L1,
  Phase.F2L2,
  Phase.F2L3,
  Phase.F2L4,
  Phase.OLL,
  Phase.PLL,
  Phase.AUF,
];

/**
 * A contiguous run of moves belonging to one phase.
 *
 * `start` is inclusive, `end` exclusive, indexing the solution's move list. Spans partition
 * it exactly: no gaps, no overlaps, and `end === start` for a skipped phase — an OLL skip is
 * an event worth reporting, not a parse failure.
 */
export interface PhaseSpan {
  readonly phase: Phase;
  readonly start: number;
  readonly end: number;
  readonly moves: readonly Move[];
  /** Non-rotation moves, i.e. the slice turn metric for this phase. */
  readonly turns: number;
  readonly rotations: number;
  /** Which F2L slot this span filled, for the F2L phases. */
  readonly slot?: string;
}

export interface SolveSegmentation {
  /**
   * The cross colour, as a face index in the normalised frame where index equals colour.
   * `Face.U` is the colour that starts on U under WCA scrambling.
   */
  readonly crossFace: Face;
  readonly spans: readonly PhaseSpan[];
  /**
   * True when a pair was already standing once the cross was finished and squared up —
   * the conventional meaning of an xcross, which is one block of work rather than two
   * phases that happen to end on the same move.
   */
  readonly xcross: boolean;
  /** How many pairs the cross came with: 0 normally, 1 for an xcross, 2 for an xxcross. */
  readonly freePairs: number;
  /**
   * True when the cross phase ended with the cross still a turn out of place, corrected
   * later — the pseudoslotting family of techniques.
   */
  readonly pseudoCross: boolean;
  /** How far the cross layer sat from home when the cross phase ended, 0-3. */
  readonly crossOffsetAtEnd: number;
  /** Phases in which no turn was made — a skip, or a pair that came for free. */
  readonly skips: readonly Phase[];
  readonly totalTurns: number;
  readonly totalRotations: number;
}

/** Why a solve could not be segmented. */
export type SegmentationFailure =
  | "does-not-solve"
  | "no-cross-found"
  | "no-f2l-found";

export interface SegmentationResult {
  readonly segmentation: SolveSegmentation | null;
  readonly failure: SegmentationFailure | null;
  readonly detail: string | null;
}
