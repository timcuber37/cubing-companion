/**
 * Planning and review, for S5 of `SWIFT_PLAN.md`: the decision diff, "which pair next", and the
 * grip a replay is shown from.
 *
 * Built from the twenty verified reconstructions of real solves in `reconstructions.json` rather
 * than from synthetic ones, and for a reason specific to this corpus: review is where the frame
 * bookkeeping lives — inspection rotations, rotations mid-solve, wide moves, setup rotations
 * prefixed onto every suggestion so it is executable from where the cube actually was. Synthetic
 * solves are face turns from a standard orientation, and never reach any of it.
 *
 * Everything runs with the model weights the app ships (`WEIGHTS`), so the recorded confidences,
 * reasons and cross choices are what a user sees — and a port that reads the weights wrongly still
 * returns plausible advice, which is exactly why it has to be pinned rather than eyeballed.
 */
import { applyMoves, CubeState, parseMoves, serializeMoves, type Face } from "@cubing-companion/engine";
import { segmentFromState } from "@cubing-companion/analysis";
import { solveStartIndex } from "@cubing-companion/metrics";
import {
  diffSolve,
  framesPuttingColourDown,
  gripObservations,
  inferGrip,
  rankOpenPairs,
  renameMoves,
  scorerFor,
} from "@cubing-companion/planner";
import RECONSTRUCTIONS from "../../packages/engine/test/fixtures/reconstructions.json" with { type: "json" };
import type { VectorFile } from "./cases.ts";

const ALL_FACES = [0, 1, 2, 3, 4, 5] as Face[];

/** Reconstructions carry `// phase` annotations; the notation parser does not want them. */
const stripComments = (text: string): string =>
  text.replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").trim();

/** Plain JSON, `undefined` fields dropped, as the file will hold it. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** @param count how many reconstructions to review; all twenty is the whole corpus. */
export async function reviewVectors(seed: number, count: number): Promise<VectorFile> {
  const scorers = { cross: scorerFor("cross"), pair: scorerFor("pair") };
  const cases: unknown[] = [];

  for (const fixture of RECONSTRUCTIONS.fixtures.slice(0, count)) {
    const scramble = parseMoves(stripComments(fixture.scramble));
    const solution = parseMoves(stripComments(fixture.solution));
    const start = applyMoves(CubeState.solved(), scramble);
    const { segmentation } = segmentFromState(start, solution);
    if (!segmentation) continue;
    const spans = segmentation.spans;

    // The grip the replay is shown from, and the move text as it reads from there.
    const states = [start];
    for (const move of solution) states.push(applyMoves(states[states.length - 1]!, [move]));
    const firstTurn = Math.min(solveStartIndex(solution), states.length - 1);
    const grip = inferGrip(gripObservations(spans), framesPuttingColourDown(states[firstTurn]!.centers, segmentation.crossFace));

    // "Which pair next" from two real positions in each solve: just after the cross, and after the
    // first pair — so both a four-slot and a three-slot decision are covered.
    const nextPairs = [];
    for (const phase of ["f2l1", "f2l2"]) {
      const span = spans.find((s) => s.phase === phase);
      if (!span) continue;
      const raw = states[span.start]!;
      nextPairs.push({ at: span.start, ...plain(await rankOpenPairs(raw, ALL_FACES, scorers.pair)) });
    }

    cases.push({
      id: fixture.id,
      scramble: serializeMoves(scramble),
      solution: serializeMoves(solution),
      crossFace: segmentation.crossFace,
      grip: {
        rotation: grip.text,
        firstTurn,
        moveText: solution.map((move) => serializeMoves(renameMoves([move], grip))),
      },
      diff: plain(await diffSolve(start, solution, scorers)),
      nextPairs,
    });
  }
  return { generator: "review", seed, count, cases };
}
