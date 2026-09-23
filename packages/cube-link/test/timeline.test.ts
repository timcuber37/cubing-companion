/**
 * Timestamp reconstruction.
 *
 * These are the tests that stand in for hardware. A real cube's awkward behaviour — moves
 * batched into one packet, host timestamps missing on all but the newest, a cube clock
 * running a couple of percent fast — is reproduced here exactly and on demand, which is not
 * something you can arrange by turning a physical cube.
 */
import { describe, expect, it } from "vitest";
import { MoveTimeline } from "../src/timeline.ts";
import { recordingFromAlg } from "../src/replay.ts";
import type { MoveEvent } from "../src/source.ts";
import { parseMoves } from "@cubing-companion/engine";

const MOVE = parseMoves("R")[0]!;

const event = (
  cubeTimestamp: number | null,
  localTimestamp: number | null,
  serial = 1,
): MoveEvent => ({ move: MOVE, serial, cubeTimestamp, localTimestamp });

describe("clock fitting", () => {
  it("recovers host timestamps for moves that never had one", () => {
    // 12 moves, 200ms apart, arriving three to a packet: only every third carries a host
    // timestamp. The cube's clock runs 2% fast.
    const recording = recordingFromAlg("R U R' U' R U R' U' R U R' U'", {
      intervalMs: 200,
      batchSize: 3,
      cubeClockRate: 1.02,
      localEpoch: 1000,
    });
    expect(recording.filter((r) => r.localTimestamp === null)).toHaveLength(8);

    const events = recording.map((r, i) => ({ ...r, move: r.move, serial: i }));
    const timeline = new MoveTimeline();
    const timed = events.map((e) => timeline.add(e));

    // Live, the opening moves cannot be placed — no host timestamp has arrived yet to
    // anchor the cube clock against. Saying so is better than inventing a number.
    expect(timed[0]!.timestampSource).toBe("none");
    expect(timed[1]!.timestampSource).toBe("none");

    // Everything after the first anchor is placed on the true 200ms grid.
    const fitted = timed.filter((t) => t.timestampSource === "fitted");
    expect(fitted.length).toBeGreaterThan(4);
    for (const move of fitted) {
      const index = timed.indexOf(move);
      expect(move.timestamp!).toBeCloseTo(1000 + index * 200, 6);
    }
  });

  it("degrades the same way live and in batch", () => {
    // retime is what A3 will run over a finished solve, so its fallbacks matter as much as
    // the happy path.
    const manualOnly = [
      event(null, 1000, 0),
      event(null, 1200, 1),
    ];
    expect(MoveTimeline.retime(manualOnly).map((t) => t.timestampSource)).toEqual([
      "local",
      "local",
    ]);

    // A single anchor gives an offset but no rate.
    const oneAnchor = [event(500, 2000, 0), event(700, null, 1)];
    const offset = MoveTimeline.retime(oneAnchor);
    expect(offset[1]!.timestampSource).toBe("cube-offset");
    expect(offset[1]!.timestamp).toBe(2200);

    // Nothing at all stays nothing, rather than becoming a guess.
    expect(MoveTimeline.retime([event(null, null, 0)])[0]).toMatchObject({
      timestamp: null,
      timestampSource: "none",
    });

    expect(MoveTimeline.retime([])).toEqual([]);
  });

  it("does not disturb the live timeline when retiming", () => {
    const timeline = new MoveTimeline();
    timeline.add(event(0, 1000, 0));
    timeline.add(event(200, 1200, 1));
    const before = timeline.skewPercent();

    MoveTimeline.retime([event(0, 5000, 0), event(1000, 5100, 1)]);
    expect(timeline.skewPercent()).toBe(before);
  });

  it("places every move once the whole stream is available", () => {
    // What A3 will do with a finished solve: fit over everything, then resolve the moves
    // that could not be placed live.
    const recording = recordingFromAlg("R U R' U' R U R' U' R U R' U'", {
      intervalMs: 200,
      batchSize: 3,
      cubeClockRate: 1.02,
      localEpoch: 1000,
    });
    const events = recording.map((r, i) => ({ ...r, move: r.move, serial: i }));

    const timed = MoveTimeline.retime(events);
    expect(timed.every((t) => t.timestamp !== null)).toBe(true);
    expect(timed.every((t) => t.timestampSource === "fitted")).toBe(true);
    timed.forEach((move, index) => {
      expect(move.timestamp!).toBeCloseTo(1000 + index * 200, 6);
    });
  });

  it("measures clock skew, and gets the direction right", () => {
    const timeline = new MoveTimeline();
    // Cube ticks 1.02ms for every 1ms of host time: the cube runs 2% fast.
    for (let i = 0; i < 10; i++) {
      timeline.add(event(i * 204, 1000 + i * 200, i));
    }
    expect(timeline.skewPercent()).toBeCloseTo(2, 6);
  });

  it("reports no skew when the clocks agree", () => {
    const timeline = new MoveTimeline();
    for (let i = 0; i < 10; i++) timeline.add(event(i * 200, 1000 + i * 200, i));
    expect(timeline.skewPercent()).toBeCloseTo(0, 6);
  });

  it("does not claim a skew before it can measure one", () => {
    const timeline = new MoveTimeline();
    expect(timeline.skewPercent()).toBeNull();
    timeline.add(event(0, 1000));
    expect(timeline.skewPercent()).toBeNull(); // one anchor is not a line
  });

  it("beats a plain offset over a long stream", () => {
    // The point of fitting rather than offsetting: with a 2% skew, a fixed offset taken at
    // the start drifts further out with every move.
    const count = 100;
    const timeline = new MoveTimeline();
    let fittedError = 0;
    let offsetError = 0;
    const offset = 1000 - 0; // anchor taken from the first move
    for (let i = 0; i < count; i++) {
      const trueLocal = 1000 + i * 200;
      const cube = i * 204;
      // Only every fifth move carries a host timestamp.
      const local = i % 5 === 0 ? trueLocal : null;
      const timed = timeline.add(event(cube, local, i));
      fittedError += Math.abs(timed.timestamp! - trueLocal);
      offsetError += Math.abs(cube + offset - trueLocal);
    }
    expect(fittedError / count).toBeLessThan(1);
    expect(offsetError / count).toBeGreaterThan(100);
  });
});

describe("fallbacks", () => {
  it("uses the host clock when the cube provides none", () => {
    // Manual input has no second clock, and must still work.
    const timeline = new MoveTimeline();
    const timed = timeline.add(event(null, 4321));
    expect(timed.timestamp).toBe(4321);
    expect(timed.timestampSource).toBe("local");
  });

  it("offsets from the last anchor before a fit is possible", () => {
    const timeline = new MoveTimeline();
    timeline.add(event(1000, 5000)); // one anchor: enough to offset, not to fit
    const timed = timeline.add(event(1200, null));
    expect(timed.timestampSource).toBe("cube-offset");
    expect(timed.timestamp).toBe(5200);
  });

  it("admits when it has nothing", () => {
    const timeline = new MoveTimeline();
    const timed = timeline.add(event(null, null));
    expect(timed.timestamp).toBeNull();
    expect(timed.timestampSource).toBe("none");
  });

  it("does not fit when every anchor shares a cube timestamp", () => {
    // Degenerate input: no rate information, so a fit would be a division by zero.
    const timeline = new MoveTimeline();
    for (let i = 0; i < 5; i++) timeline.add(event(500, 1000 + i, i));
    expect(timeline.skewPercent()).toBeNull();
    expect(timeline.add(event(500, null)).timestampSource).toBe("cube-offset");
  });
});

describe("windowing", () => {
  it("keeps the anchor window bounded", () => {
    const timeline = new MoveTimeline({ windowSize: 8 });
    for (let i = 0; i < 50; i++) timeline.add(event(i * 200, 1000 + i * 200, i));
    expect(timeline.anchorCount).toBe(8);
  });

  it("tracks drift that changes partway through", () => {
    // A rolling window should follow a rate change rather than averaging across it.
    const timeline = new MoveTimeline({ windowSize: 10 });
    for (let i = 0; i < 30; i++) timeline.add(event(i * 200, 1000 + i * 200, i));
    expect(timeline.skewPercent()).toBeCloseTo(0, 3);

    let cube = 30 * 200;
    let local = 1000 + 30 * 200;
    for (let i = 0; i < 30; i++) {
      cube += 210;
      local += 200;
      timeline.add(event(cube, local, i));
    }
    expect(timeline.skewPercent()).toBeCloseTo(5, 1);
  });

  it("forgets everything on reset", () => {
    const timeline = new MoveTimeline();
    for (let i = 0; i < 5; i++) timeline.add(event(i * 200, 1000 + i * 200, i));
    expect(timeline.anchorCount).toBe(5);
    timeline.reset();
    expect(timeline.anchorCount).toBe(0);
    expect(timeline.skewPercent()).toBeNull();
  });
});

describe("recovered moves", () => {
  /**
   * A move recovered from the cube's move history carries neither clock. Before interpolation
   * these were dropped from every metric — which does not merely lose a move, it invents a pause,
   * because the moves either side become adjacent and the gap between them looks like hesitation.
   */
  it("places a recovered move between its neighbours", () => {
    const timed = MoveTimeline.retime([
      event(1000, 1000, 1),
      event(null, null, 2), // recovered: no clock of its own
      event(1200, 1200, 3),
    ]);

    expect(timed[1]!.timestampSource).toBe("interpolated");
    expect(timed[1]!.timestamp).toBeCloseTo(1100, 6);
  });

  it("spaces a run of recovered moves evenly", () => {
    const timed = MoveTimeline.retime([
      event(1000, 1000, 1),
      event(null, null, 2),
      event(null, null, 3),
      event(null, null, 4),
      event(1400, 1400, 5),
    ]);

    expect(timed.slice(1, 4).map((move) => move.timestampSource)).toEqual([
      "interpolated",
      "interpolated",
      "interpolated",
    ]);
    expect(timed.slice(1, 4).map((move) => move.timestamp)).toEqual([1100, 1200, 1300]);
  });

  it("leaves the resolved moves exactly as they were", () => {
    const events = [event(1000, 1000, 1), event(null, null, 2), event(1200, 1200, 3)];
    const timed = MoveTimeline.retime(events);
    expect(timed[0]!.timestampSource).toBe("fitted");
    expect(timed[2]!.timestampSource).toBe("fitted");
    expect(timed[0]!.timestamp).toBeCloseTo(1000, 6);
    expect(timed[2]!.timestamp).toBeCloseTo(1200, 6);
  });

  it("refuses to extrapolate past either end", () => {
    // Nothing on one side means nothing to interpolate between. Guessing from one side would be
    // invention rather than estimation, so these stay unplaced and say so.
    const timed = MoveTimeline.retime([
      event(null, null, 1),
      event(1000, 1000, 2),
      event(1200, 1200, 3),
      event(null, null, 4),
    ]);
    expect(timed[0]!.timestampSource).toBe("none");
    expect(timed[0]!.timestamp).toBeNull();
    expect(timed[3]!.timestampSource).toBe("none");
    expect(timed[3]!.timestamp).toBeNull();
  });

  it("keeps time moving forwards through a recovered run", () => {
    const timed = MoveTimeline.retime([
      event(0, 0, 1),
      event(null, null, 2),
      event(null, null, 3),
      event(500, 500, 4),
      event(null, null, 5),
      event(900, 900, 6),
    ]);
    const times = timed.map((move) => move.timestamp!);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!, `move ${i}`).toBeGreaterThan(times[i - 1]!);
    }
  });
});

describe("batching, at the rates a phone would see", () => {
  /**
   * The question this answers is "does iOS break the metrics", and it needs no iOS.
   *
   * A longer BLE connection interval batches more moves per notification, so fewer of them carry
   * a host timestamp and the fit has fewer anchors. iOS enforces a 15ms minimum interval against
   * Android's ~11.25ms, so the worry is real. But every metric downstream is a *difference* of
   * fitted cube timestamps, and the cube stamps every move itself — so losing anchors costs
   * precision in the fit, not the spacing between moves.
   */
  it.each([
    { batchSize: 1, label: "every move stamped" },
    { batchSize: 3, label: "a third stamped" },
    { batchSize: 8, label: "an eighth stamped" },
  ])("recovers the true move spacing when $label", ({ batchSize }) => {
    const recording = recordingFromAlg("R U R' U' R U R' U' R U R' U' R U R' U'", {
      intervalMs: 125, // 8 TPS
      batchSize,
      cubeClockRate: 1.02,
      localEpoch: 5000,
    });

    const timed = MoveTimeline.retime(
      recording.map((move, i) => ({ ...move, serial: i })),
    );

    const placed = timed.filter((move) => move.timestamp !== null);
    expect(placed).toHaveLength(recording.length);

    for (let i = 1; i < placed.length; i++) {
      // Within a millisecond of the true grid regardless of how heavily the stream was batched.
      expect(placed[i]!.timestamp! - placed[i - 1]!.timestamp!).toBeCloseTo(125, 0);
    }
  });
});
