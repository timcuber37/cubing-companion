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
  /** Reserve room for longer alternatives by limiting candidates at each depth. */
  readonly maxSolutionsPerDepth?: number;
  /** Deterministic work budget. Omit for exhaustive search within the depth ceiling. */
  readonly maxNodes?: number;
  /**
   * Wall-clock budget in milliseconds, from the moment the search starts.
   *
   * The device-independent companion to `maxNodes`, which is device-independent in *work* and so
   * wildly device-dependent in *time*: the same sweep measured 2.32 s on a desktop and 5.45 s on
   * an iPhone 11. A UI with a latency requirement wants this; a benchmark or a test wants
   * `maxNodes`, because the same input must do the same work every time.
   *
   * Both may be given, and whichever bites first stops the search. Either way `stats.truncated`
   * says it happened.
   */
  readonly deadlineMs?: number;
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
