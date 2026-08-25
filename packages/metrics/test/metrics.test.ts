/**
 * Per-phase metrics.
 *
 * The invariants worth holding onto are the additive ones — phase durations summing to the solve,
 * recognition plus execution summing to the phase. They are what makes a breakdown trustworthy:
 * a user who adds up the phases and gets a different number than the solve time stops believing
 * any of it.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Phase, type PhaseSpan } from "@cubing-companion/analysis";
import type { Move } from "@cubing-companion/engine";
import { computeMetrics, phaseDurationsMs } from "../src/metrics.ts";

const FILLER: Move = { family: "R", amount: 1 };

function span(
  phase: Phase,
  start: number,
  end: number,
  extra: { rotations?: number; slot?: string } = {},
): PhaseSpan {
  return {
    phase,
    start,
    end,
    moves: Array.from({ length: end - start }, () => FILLER),
    turns: end - start - (extra.rotations ?? 0),
    rotations: extra.rotations ?? 0,
    ...(extra.slot === undefined ? {} : { slot: extra.slot }),
  };
}

/** A seven-phase solve of 28 moves, evenly paced unless told otherwise. */
const SPANS: readonly PhaseSpan[] = [
  span(Phase.Cross, 0, 6),
  span(Phase.F2L1, 6, 10, { slot: "FR" }),
  span(Phase.F2L2, 10, 14, { slot: "FL" }),
  span(Phase.F2L3, 14, 18, { slot: "BL" }),
  span(Phase.F2L4, 18, 22, { slot: "BR" }),
  span(Phase.OLL, 22, 25),
  span(Phase.PLL, 25, 28),
];

const evenTimeline = (count: number, gapMs = 150) =>
  Array.from({ length: count }, (_, i) => 5000 + i * gapMs);

/** Push everything from `index` onwards later, i.e. insert a stall before move `index`. */
const stallBefore = (timestamps: readonly number[], index: number, ms: number): number[] =>
  timestamps.map((t, i) => (i >= index ? t + ms : t));

describe("phase durations", () => {
  it("sum to the solve duration exactly", () => {
    const timestamps = evenTimeline(28);
    const metrics = computeMetrics(SPANS, timestamps);
    const summed = metrics.phases.reduce((total, p) => total + p.durationMs!, 0);
    expect(summed).toBe(metrics.durationMs);
  });

  it("still sum exactly when the pace is ragged", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 40, max: 3000 }), { minLength: 27, maxLength: 27 }),
        (gaps) => {
          const timestamps = [1000];
          for (const gap of gaps) timestamps.push(timestamps[timestamps.length - 1]! + gap);
          const metrics = computeMetrics(SPANS, timestamps);
          const summed = metrics.phases.reduce((total, p) => total + p.durationMs!, 0);
          expect(summed).toBe(metrics.durationMs);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("charge the gap before a phase to the phase that needed it", () => {
    // A 2-second stall before the first move of pair 2 is pair 2's recognition, not pair 1's
    // execution. The pair that could not be found is the one that pays.
    const timestamps = stallBefore(evenTimeline(28), 10, 2000);

    const metrics = computeMetrics(SPANS, timestamps);
    const pair1 = metrics.phases.find((p) => p.phase === Phase.F2L1)!;
    const pair2 = metrics.phases.find((p) => p.phase === Phase.F2L2)!;
    expect(pair1.durationMs).toBe(4 * 150);
    expect(pair2.recognitionMs).toBe(2150);
    expect(pair2.durationMs).toBe(2150 + 3 * 150);
  });

  it("give the opening interval to nobody", () => {
    // The clock starts when the first move lands, so the cross covers one interval fewer than a
    // later phase of the same length. This is what makes the sum come out exact.
    const metrics = computeMetrics(SPANS, evenTimeline(28));
    const cross = metrics.phases[0]!;
    expect(cross.durationMs).toBe(5 * 150);
    expect(cross.recognitionMs).toBe(0);
    expect(cross.executionMs).toBe(cross.durationMs);
  });

  it("report a skipped phase as zero, not unknown", () => {
    // An OLL skip is an event worth reporting, not missing data.
    const withSkip = [
      span(Phase.Cross, 0, 6),
      span(Phase.F2L1, 6, 10),
      span(Phase.OLL, 10, 10),
      span(Phase.PLL, 10, 14),
    ];
    const metrics = computeMetrics(withSkip, evenTimeline(14));
    const oll = metrics.phases.find((p) => p.phase === Phase.OLL)!;
    expect(oll.durationMs).toBe(0);
    expect(oll.turns).toBe(0);
    expect(oll.tps).toBeNull();
  });

  it("are unknown, not zero, when a phase boundary has no clock", () => {
    // The opening moves of a batched Bluetooth stream can arrive without a usable host clock.
    // Only the boundaries are read, so pair 1 loses its end and becomes unknown, while pair 2
    // falls back to its own first move and stays measurable.
    const timestamps: (number | null)[] = evenTimeline(28);
    timestamps[9] = null;
    const durations = phaseDurationsMs(SPANS, timestamps);
    expect(durations[1]).toBeNull();
    expect(durations[2]).not.toBeNull();
  });

  it("survive a gap in the middle of a phase, which changes no boundary", () => {
    const timestamps: (number | null)[] = evenTimeline(28);
    timestamps[7] = null;
    expect(phaseDurationsMs(SPANS, timestamps)[1]).toBe(4 * 150);
  });

  it("agree with the standalone helper", () => {
    const timestamps = evenTimeline(28);
    expect(phaseDurationsMs(SPANS, timestamps)).toEqual(
      computeMetrics(SPANS, timestamps).phases.map((p) => p.durationMs),
    );
  });
});

describe("recognition and execution", () => {
  it("partition the phase exactly", () => {
    const metrics = computeMetrics(SPANS, evenTimeline(28));
    for (const phase of metrics.phases) {
      expect(phase.recognitionMs! + phase.executionMs!, phase.phase).toBe(phase.durationMs);
    }
  });

  it("put a long hunt into recognition rather than execution", () => {
    const timestamps = stallBefore(evenTimeline(28), 14, 1800);

    const pair3 = computeMetrics(SPANS, timestamps).phases.find(
      (p) => p.phase === Phase.F2L3,
    )!;
    expect(pair3.recognitionMs).toBe(1950);
    expect(pair3.executionMs).toBe(3 * 150);
    expect(pair3.recognitionShare).toBeCloseTo(1950 / 2400, 5);
  });
});

describe("rates and totals", () => {
  it("count turns and rotations across the solve", () => {
    const spans = [span(Phase.Cross, 0, 8, { rotations: 2 }), span(Phase.F2L1, 8, 12)];
    const metrics = computeMetrics(spans, evenTimeline(12));
    expect(metrics.turns).toBe(6 + 4);
    expect(metrics.rotations).toBe(2);
  });

  it("exclude rotations from TPS, which is a turning rate", () => {
    const spans = [span(Phase.Cross, 0, 11, { rotations: 1 })];
    // Ten intervals of 100 ms: one second of solve, ten moves, one of them a rotation.
    const metrics = computeMetrics(spans, evenTimeline(11, 100));
    expect(metrics.durationMs).toBe(1000);
    expect(metrics.tps).toBe(10);
  });

  it("decline to divide by a duration that is zero or unknown", () => {
    expect(computeMetrics(SPANS, evenTimeline(28).fill(7000)).tps).toBeNull();
    expect(computeMetrics(SPANS, Array(28).fill(null)).tps).toBeNull();
  });
});

describe("fluidity", () => {
  it("is one when nothing stopped", () => {
    expect(computeMetrics(SPANS, evenTimeline(28)).fluidity).toBe(1);
  });

  it("falls by exactly the share of time spent paused", () => {
    const timestamps = stallBefore(evenTimeline(28), 12, 3000);

    const metrics = computeMetrics(SPANS, timestamps);
    expect(metrics.pauses).toHaveLength(1);
    expect(metrics.pausedMs).toBe(3150);
    expect(metrics.fluidity).toBeCloseTo(1 - 3150 / metrics.durationMs!, 5);
  });

  it("attributes each pause to the phase whose move it precedes", () => {
    const timestamps = stallBefore(evenTimeline(28), 19, 2500);

    const metrics = computeMetrics(SPANS, timestamps);
    const pair4 = metrics.phases.find((p) => p.phase === Phase.F2L4)!;
    expect(pair4.pauses).toHaveLength(1);
    expect(pair4.pausedMs).toBe(2650);
    // And the phase durations still sum, pause or no pause.
    expect(metrics.phases.reduce((t, p) => t + p.durationMs!, 0)).toBe(metrics.durationMs);
  });

  it("names the worst stall", () => {
    const timestamps = stallBefore(stallBefore(evenTimeline(28), 8, 800), 20, 2400);

    const metrics = computeMetrics(SPANS, timestamps);
    expect(metrics.pauses).toHaveLength(2);
    expect(metrics.longestPause!.moveIndex).toBe(20);
    expect(metrics.longestPause!.durationMs).toBe(2550);
  });

  it("is unknown rather than perfect when the solve carries no clock", () => {
    const metrics = computeMetrics(SPANS, Array(28).fill(null));
    expect(metrics.fluidity).toBeNull();
    expect(metrics.durationMs).toBeNull();
  });
});
