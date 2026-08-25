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
import { phaseDurationsMs } from "@cubing-companion/metrics";
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

  // The rule for what a phase's elapsed time means lives in `metrics`, which owns the whole
  // per-phase breakdown; keeping a second copy of it here would be two things free to drift
  // apart. `metrics` depends only on `analysis` and `engine`, so this adds no cycle.
  const phaseDurations = phaseDurationsMs(
    segmentation.segmentation?.spans ?? [],
    record.moveTimestamps,
  );

  return { record, segmentation, phaseDurations };
}
