/**
 * What the enumerators return.
 *
 * A *candidate*, not a solution. B2 exists to feed A5's "what would a pro do" comparison and
 * B3's ranking model, and both need a set of plausible continuations rather than one optimal
 * answer — B3's training data is literally "the pro's choice, plus the alternatives they
 * passed over".
 */
import type { Move } from "@cubing-companion/engine";

export interface Candidate {
  /** The moves, in HTM face turns. */
  readonly moves: readonly Move[];
  /** Move count; the ranking signal everything else is measured against. */
  readonly length: number;
  /** How many moves longer than the optimum this is. `0` for an optimal solution. */
  readonly overOptimal: number;
  /** For an xcross, which slot the pair filled. */
  readonly slot?: string;
}

export interface SearchOptions {
  /**
   * How many moves longer than optimal to accept.
   *
   * `0` returns only optimal solutions. A coach usually wants more than that — the shortest
   * continuation is often not the one a human would pick — so this is the knob that turns a
   * solver into a source of alternatives.
   */
  readonly maxExtra?: number;
  /** Stop after this many candidates. */
  readonly maxSolutions?: number;
  /** Hard ceiling on depth, regardless of `maxExtra`. */
  readonly maxDepth?: number;
}

export interface SearchResult {
  readonly candidates: readonly Candidate[];
  /** Optimal length, or `-1` if nothing was found within the limits. */
  readonly optimal: number;
  readonly stats: SearchStats;
}

export interface SearchStats {
  readonly nodes: number;
  readonly elapsedMs: number;
  /** True when a limit stopped the search before it was exhaustive. */
  readonly truncated: boolean;
}
