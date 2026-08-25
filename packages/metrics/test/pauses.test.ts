/**
 * Pause detection.
 *
 * Everything here is built so the answer is known before the code runs: a timeline with one
 * 2-second gap inserted has exactly one 2-second pause, and no amount of threshold tuning should
 * change that.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAUSE_OPTIONS,
  detectPauses,
  medianGapMs,
  moveGaps,
  pauseThresholdMs,
} from "../src/pauses.ts";

/** A timeline with a constant gap, then whatever extra gaps are asked for at given indices. */
function timeline(count: number, gapMs: number, inserted: Record<number, number> = {}) {
  const timestamps: number[] = [1000];
  for (let i = 1; i < count; i++) {
    timestamps.push(timestamps[i - 1]! + gapMs + (inserted[i] ?? 0));
  }
  return timestamps;
}

describe("gaps", () => {
  it("are the intervals between moves, one fewer than the moves", () => {
    expect(moveGaps([0, 100, 250])).toEqual([100, 150]);
    expect(moveGaps([5])).toEqual([]);
    expect(moveGaps([])).toEqual([]);
  });

  it("are unknown where either end is", () => {
    expect(moveGaps([0, null, 250])).toEqual([null, null]);
  });

  it("have a median only when something is measurable", () => {
    expect(medianGapMs(timeline(5, 100))).toBe(100);
    // Even count averages the middle pair.
    expect(medianGapMs([0, 100, 300])).toBe(150);
    expect(medianGapMs([null, null])).toBeNull();
    expect(medianGapMs([1000])).toBeNull();
  });
});

describe("detection", () => {
  it("finds exactly the pause that was inserted", () => {
    // 20 moves at 120 ms, with one 2-second stall before move 7.
    const timestamps = timeline(20, 120, { 7: 2000 });
    const pauses = detectPauses(timestamps);

    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.moveIndex).toBe(7);
    expect(pauses[0]!.durationMs).toBe(2120);
    // Offset is measured from the first move, so it is where the pause *starts*.
    expect(pauses[0]!.offsetMs).toBe(6 * 120);
  });

  it("finds several, in move order", () => {
    const pauses = detectPauses(timeline(30, 100, { 5: 900, 12: 1500, 20: 600 }));
    expect(pauses.map((p) => p.moveIndex)).toEqual([5, 12, 20]);
  });

  it("finds nothing in an evenly-paced solve", () => {
    expect(detectPauses(timeline(40, 130))).toEqual([]);
  });

  it("never charges the gap before the first move", () => {
    // There is no measured interval before move 0 — the clock starts when it lands.
    const pauses = detectPauses(timeline(10, 100, { 1: 5000 }));
    expect(pauses.every((p) => p.moveIndex >= 1)).toBe(true);
    expect(pauses[0]!.moveIndex).toBe(1);
  });

  it("copes with a timeline that has no usable timestamps", () => {
    expect(detectPauses([null, null, null])).toEqual([]);
    expect(detectPauses([])).toEqual([]);
  });
});

describe("the threshold", () => {
  it("scales with the solver, so a pause means the same thing to everyone", () => {
    // The point of the relative half: 400 ms is a stall for a fast solver...
    const fast = timeline(30, 100, { 10: 300 });
    expect(detectPauses(fast)).toHaveLength(1);

    // ...and unremarkable for a slow one, whose own tempo is slower than that.
    const slow = timeline(30, 400, { 10: 300 });
    expect(detectPauses(slow)).toEqual([]);
  });

  it("keeps an absolute floor, so a very fast solve is not all pauses", () => {
    // At an 80 ms tempo, 2.5x is only 200 ms — below the floor, which takes over.
    const timestamps = timeline(30, 80);
    expect(pauseThresholdMs(timestamps)).toBe(DEFAULT_PAUSE_OPTIONS.minimumMs);
    expect(detectPauses(timeline(30, 80, { 10: 150 }))).toEqual([]);
  });

  it("uses the relative rule once the solver is slow enough for it to bite", () => {
    const timestamps = timeline(30, 400);
    expect(pauseThresholdMs(timestamps)).toBe(400 * DEFAULT_PAUSE_OPTIONS.relativeToMedian);
  });

  it("is adjustable, because nothing calibrates it", () => {
    // A 220 ms gap clears neither default, and clears both once they are lowered.
    const timestamps = timeline(30, 100, { 10: 120 });
    expect(detectPauses(timestamps)).toEqual([]);
    expect(
      detectPauses(timestamps, { minimumMs: 150, relativeToMedian: 1.5 }),
    ).toHaveLength(1);
  });
});
