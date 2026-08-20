/**
 * State tracking and desync recovery.
 *
 * The failure this guards against is silent: if the tracked state drifts from the cube's,
 * nothing throws and nothing looks wrong — the virtual cube just stops matching the real
 * one, and every metric derived from it is quietly worthless. So these tests are mostly
 * about making divergence *detectable*.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseMoves,
  stateAfter,
  toFacelets,
  CubeState,
} from "@cubing-companion/engine";
import { CubeTracker, serialGap } from "../src/tracker.ts";
import { recordingFromAlg, ReplaySource } from "../src/replay.ts";
import type { DesyncEvent } from "../src/source.ts";

/** A tracker over a replay source, with periodic verification off unless asked for. */
function harness(alg: string, options: { dropSerials?: number; initialState?: CubeState } = {}) {
  const source = new ReplaySource(recordingFromAlg(alg, { intervalMs: 200 }), {
    ...(options.dropSerials !== undefined ? { dropSerials: options.dropSerials } : {}),
    ...(options.initialState !== undefined ? { initialState: options.initialState } : {}),
  });
  const tracker = new CubeTracker(source, { verifyIntervalMs: 0 });
  const desyncs: DesyncEvent[] = [];
  tracker.onDesync((e) => desyncs.push(e));
  return { source, tracker, desyncs };
}

describe("serial arithmetic", () => {
  it("handles the wrap at 256", () => {
    expect(serialGap(10, 11)).toBe(1);
    expect(serialGap(255, 0)).toBe(1);
    expect(serialGap(254, 2)).toBe(4);
    expect(serialGap(0, 0)).toBe(0);
  });
});

describe("tracking", () => {
  it("follows the move stream", async () => {
    const { source, tracker } = harness("R U R' U'");
    await tracker.start();
    source.stepAll();
    expect(toFacelets(tracker.getState())).toBe(
      toFacelets(stateAfter(parseMoves("R U R' U'"))),
    );
  });

  it("seeds from the cube rather than assuming solved", async () => {
    // A cube that is already scrambled when we connect. Applying moves onto an assumed
    // solved state would be wrong from the very first move.
    const scrambled = stateAfter(parseMoves("D2 F2 L' R B"));
    const { source, tracker } = harness("R U", { initialState: scrambled });
    await tracker.start();
    expect(toFacelets(tracker.getState())).toBe(toFacelets(scrambled));

    source.stepAll();
    expect(toFacelets(tracker.getState())).toBe(
      toFacelets(stateAfter(parseMoves("D2 F2 L' R B R U"))),
    );
  });

  it("reports the initial sync as a desync event", async () => {
    const scrambled = stateAfter(parseMoves("R U R'"));
    const { tracker, desyncs } = harness("U", { initialState: scrambled });
    await tracker.start();
    expect(desyncs).toHaveLength(1);
    expect(desyncs[0]!.reason).toBe("initial-sync");
    expect(desyncs[0]!.actual).toBe(toFacelets(scrambled));
  });

  it("hands out copies, so callers cannot corrupt tracking", async () => {
    const { source, tracker } = harness("R");
    await tracker.start();
    const snapshot = tracker.getState();
    snapshot.cp[0] = 7;
    source.stepAll();
    expect(toFacelets(tracker.getState())).toBe(
      toFacelets(stateAfter(parseMoves("R"))),
    );
  });

  it("timestamps the moves it emits", async () => {
    const { source, tracker } = harness("R U R' U'");
    const seen: (number | null)[] = [];
    tracker.onMove((m) => seen.push(m.timestamp));
    await tracker.start();
    source.stepAll();
    expect(seen).toHaveLength(4);
    expect(seen.every((t) => t !== null)).toBe(true);
  });
});

describe("desync detection", () => {
  it("notices a gap in the serial numbers", async () => {
    // dropSerials: 1 means every move advances the serial by two — as if a packet were
    // lost between each pair.
    const { source, tracker, desyncs } = harness("R U R'", { dropSerials: 1 });
    await tracker.start();
    desyncs.length = 0;
    source.step();
    source.step();
    expect(desyncs.some((d) => d.reason === "serial-gap")).toBe(true);
  });

  it("does not cry wolf on a healthy stream", async () => {
    const { source, tracker, desyncs } = harness("R U R' U' F B L D");
    await tracker.start();
    desyncs.length = 0;
    source.stepAll();
    expect(desyncs).toEqual([]);
  });

  it("catches a cube turned while nothing was listening", async () => {
    // The case serials cannot catch: no packets were lost, because none were sent.
    const { source, tracker, desyncs } = harness("R U");
    await tracker.start();
    source.stepAll();
    desyncs.length = 0;

    source.applySilently("F2 D'");
    expect(await tracker.verify()).toBe(false);
    expect(desyncs).toHaveLength(1);
    expect(desyncs[0]!.reason).toBe("state-mismatch");
  });

  it("re-seeds to the cube's actual state after divergence", async () => {
    const { source, tracker } = harness("R U");
    await tracker.start();
    source.stepAll();
    source.applySilently("F2 D'");

    await tracker.verify();
    expect(toFacelets(tracker.getState())).toBe(
      toFacelets(stateAfter(parseMoves("R U F2 D'"))),
    );
  });

  it("announces a re-seed so the UI can resync the virtual cube", async () => {
    const { source, tracker } = harness("R U");
    const reseeds: CubeState[] = [];
    tracker.onReseed((s) => reseeds.push(s));
    await tracker.start();
    source.stepAll();
    source.applySilently("F2");
    await tracker.verify();
    // One for the initial sync, one for the recovery.
    expect(reseeds).toHaveLength(2);
    expect(toFacelets(reseeds[1]!)).toBe(
      toFacelets(stateAfter(parseMoves("R U F2"))),
    );
  });

  it("stays quiet when verification finds nothing wrong", async () => {
    const { source, tracker, desyncs } = harness("R U R'");
    await tracker.start();
    source.stepAll();
    desyncs.length = 0;
    expect(await tracker.verify()).toBe(true);
    expect(desyncs).toEqual([]);
  });

  it("does not let overlapping verifications race", async () => {
    const { source, tracker } = harness("R");
    await tracker.start();
    const spy = vi.spyOn(source, "queryState");
    const [a, b] = await Promise.all([tracker.verify(), tracker.verify()]);
    // The second call returns immediately rather than issuing a second round trip.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe("lifecycle", () => {
  it("schedules periodic verification when asked", async () => {
    const setIntervalSpy = vi.fn(() => 42);
    const clearIntervalSpy = vi.fn();
    const source = new ReplaySource(recordingFromAlg("R", {}));
    const tracker = new CubeTracker(source, {
      verifyIntervalMs: 5000,
      setInterval: setIntervalSpy,
      clearInterval: clearIntervalSpy,
    });

    await tracker.start();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

    await tracker.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(42);
  });

  it("stops tracking when the source disconnects", async () => {
    const { source, tracker } = harness("R U R'");
    await tracker.start();
    source.step();
    await source.disconnect();

    const before = toFacelets(tracker.getState());
    source.step();
    expect(toFacelets(tracker.getState())).toBe(before);
  });

  it("can be stopped more than once", async () => {
    const { tracker } = harness("R");
    await tracker.start();
    await tracker.stop();
    await expect(tracker.stop()).resolves.toBeUndefined();
  });
});
