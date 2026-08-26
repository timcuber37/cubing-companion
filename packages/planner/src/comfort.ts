/**
 * How comfortable a solution is to turn, fitted to what pros actually do.
 *
 * Two solutions of the same length are not equally good. `solver` deliberately refuses to say
 * which is better — its README puts ranking beyond move count in B3's hands — but a planner has
 * to put something at the top of the list, and "whichever the search happened to find first" is
 * not a defensible answer.
 *
 * So this is fitted rather than invented. Taking the 2,744 corpus crosses built entirely from
 * outer face turns — the population the search can actually produce — their 16,834 turns fall on
 * the six faces like this:
 *
 * ```
 *   D  29.3%   R  29.2%   F  16.5%   U  12.7%   L  9.9%   B  2.5%
 * ```
 *
 * The back face is turned **twelve times less often than the right**, and the left three times
 * less. That is a strong, cheap signal, and it is measured rather than argued.
 *
 * ## It predicts something the fit does not guarantee
 *
 * Re-checking those frequencies against the corpus would be circular. The real question is
 * whether the model picks the frame a pro *actually held the cube in*, which the aggregate fit
 * says nothing about — a model can have the right average and still be useless per solve.
 *
 * Fitted on 10,857 pre-2022 turns and scored with **those weights only** on the 946 crosses from
 * 2022 onwards, the pro's own frame comes out top of the four **79.4% of the time — 76.1%
 * outright, with no tie — against a 25% chance baseline.** The shares shipped below are the
 * whole-corpus fit; the split existed to keep that test honest.
 *
 * ## What this model is not
 *
 * It is a bag of moves. It has no idea about move *order*, which is where most real ergonomics
 * lives: regrips, whether a pair of turns is a comfortable trigger, whether the solution ends
 * with your hands in position for the first pair. A solution and its reverse score identically,
 * which is obviously wrong.
 *
 * It is a placeholder behind a stable interface, and B3's learned ranker is meant to replace
 * `comfortScore` without anything else moving. What it buys in the meantime is that the planner
 * stops recommending solutions nobody would turn.
 */
import type { Move } from "@cubing-companion/engine";

/**
 * Share of corpus cross turns on each face.
 *
 * Measured, not chosen. Regenerate by counting move families across the cross spans in
 * `data/corpus.jsonl`, restricted to crosses that use nothing but outer face turns — half the
 * corpus reaches for a wide move or a slice somewhere, and including those crosses would fit the
 * model to moves the search cannot offer.
 */
export const FACE_SHARE: Readonly<Record<string, number>> = {
  D: 0.293,
  R: 0.292,
  F: 0.165,
  U: 0.127,
  L: 0.099,
  B: 0.025,
};

/** The two ends of the scale, used to normalise a score into something displayable. */
const BEST = Math.log(Math.max(...Object.values(FACE_SHARE)));
const WORST = Math.log(Math.min(...Object.values(FACE_SHARE)));

/**
 * How comfortable a sequence looks, from 0 (every turn on the back face) to 1 (all on D/R).
 *
 * The mean log-share of the moves — the likelihood of the sequence under a unigram model of pro
 * cross turns — rescaled so the number means something to a reader. Taking the *mean* rather
 * than the sum keeps it independent of length, which matters because length is ranked first and
 * comfort must not smuggle a length preference in behind it.
 */
export function comfortScore(moves: readonly Move[]): number {
  if (moves.length === 0) return 1;

  let total = 0;
  for (const move of moves) {
    const share = FACE_SHARE[move.family];
    // A family outside the model — a wide move or a slice — is treated as the worst case rather
    // than skipped, so an unexpected input can never score as comfortable.
    total += Math.log(share ?? Math.min(...Object.values(FACE_SHARE)));
  }

  return (total / moves.length - WORST) / (BEST - WORST);
}

/** Turns on faces pros mostly avoid, which is the concrete thing behind a low score. */
export function awkwardTurns(moves: readonly Move[]): { readonly back: number; readonly left: number } {
  return {
    back: moves.filter((move) => move.family === "B").length,
    left: moves.filter((move) => move.family === "L").length,
  };
}
