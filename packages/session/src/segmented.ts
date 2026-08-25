/**
 * Joining a stored record to the segmenter.
 *
 * Segmentation is derived, not stored. Re-running it on read costs microseconds and means an
 * improvement to the segmenter applies to every solve ever recorded, instead of leaving old
 * records frozen against whatever version happened to be running that day. That matters here
 * more than usual: the segmenter's accuracy moved from 0% to 97% during a single afternoon of
 * work on it.
 */
import { fromFacelets, parseMoves } from "@cubing-companion/engine";
import {
  segmentFromState,
  type SegmentationResult,
} from "@cubing-companion/analysis";
import type { SolveRecord } from "./types.ts";

export interface SegmentedSolve {
  readonly record: SolveRecord;
  readonly segmentation: SegmentationResult;
  /**
   * Per-phase durations in milliseconds, aligned with `segmentation.spans`.
   *
   * `null` where the moves bounding a phase carry no usable timestamp — which happens for the
   * opening moves of a batched Bluetooth stream even after retiming, if no host timestamp
   * arrived early enough to anchor them.
   */
  readonly phaseDurations: readonly (number | null)[];
}

/**
 * Segment a stored solve, and attach a duration to each phase.
 *
 * Uses `startFacelets` rather than `scrambleText`, which is the point of storing it: a
 * mis-scrambled solve segments correctly instead of being analysed against a scramble the cube
 * never actually reached.
 */
export function segmentRecord(record: SolveRecord): SegmentedSolve {
  const startState = fromFacelets(record.startFacelets);
  const solution = parseMoves(record.solution);
  const segmentation = segmentFromState(startState, solution);

  const phaseDurations = (segmentation.segmentation?.spans ?? []).map((span) => {
    if (span.end === span.start) return 0;
    // A phase runs from the move before it to its last move: the elapsed time *of* the phase
    // is the gap between the previous move landing and this phase's final move landing.
    //
    // The first phase has no previous move, so it falls back to its own first — meaning it
    // covers one interval fewer than a later phase of the same move count. That is correct
    // rather than an off-by-one: the clock starts when the first move lands, so the time
    // before it belongs to nobody, and it is what makes the phase durations sum to the
    // solve duration exactly.
    const from = record.moveTimestamps[span.start - 1] ?? record.moveTimestamps[span.start];
    const to = record.moveTimestamps[span.end - 1];
    if (from == null || to == null) return null;
    return to - from;
  });

  return { record, segmentation, phaseDurations };
}
