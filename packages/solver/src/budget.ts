/**
 * Stopping a search on a clock rather than on a node count.
 *
 * `maxNodes` is a budget of *work*. That is exactly what a benchmark wants — the same input does
 * the same work everywhere, so results compare — and exactly what a user interface does not, since
 * the same work takes different amounts of time on different devices. Measured on the same
 * workload, an iPhone 11 ran the planner's colour-neutral sweep in 5.45 s against a desktop's
 * 2.32 s: a 2.4× spread, and a wider one against an older phone or a newer laptop.
 *
 * So a search can be given a deadline as well. `maxNodes` stays, and stays the default, because
 * reproducibility is worth more than responsiveness in a test; `deadlineMs` is what a UI passes
 * when the honest requirement is "answer within this long, with whatever you found".
 *
 * **The clock is sampled, not read per node.** `Date.now()` costs more than the node it would be
 * guarding — a depth-first step here is a handful of array writes — so reading it every time would
 * make the budget its own bottleneck. Every few thousand nodes is frequent enough to land within a
 * millisecond or two of the deadline and cheap enough to disappear into the noise.
 */

/**
 * Nodes between clock reads.
 *
 * Chosen so the check costs well under a percent of search time while still landing close to the
 * deadline: the enumerators run on the order of a million nodes a second, so this is roughly a
 * read every four milliseconds.
 */
const SAMPLE_EVERY = 4096;

export interface Budget {
  /** True once the deadline has passed. Cheap to call; reads the clock only occasionally. */
  readonly expired: (nodes: number) => boolean;
}

/**
 * A budget that never expires.
 *
 * The common case — most callers pass only `maxNodes` — so it is a distinct object rather than a
 * deadline of `Infinity`, and the check compiles down to returning false.
 */
const UNLIMITED: Budget = { expired: () => false };

/**
 * Build a budget for a search that started now.
 *
 * @param deadlineMs milliseconds from now, or undefined for no time limit.
 * @param clock injected for tests; defaults to the wall clock the enumerators already use.
 */
export function budgetFor(
  deadlineMs: number | undefined,
  clock: () => number = Date.now,
): Budget {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs)) return UNLIMITED;
  // A non-positive deadline means "do nothing", which is a legitimate thing to ask for and a
  // useful thing to be able to test.
  const deadlineAt = clock() + Math.max(0, deadlineMs);

  let nextCheck = 0;
  let done = false;
  return {
    expired(nodes: number): boolean {
      if (done) return true;
      if (nodes < nextCheck) return false;
      nextCheck = nodes + SAMPLE_EVERY;
      done = clock() >= deadlineAt;
      return done;
    },
  };
}
