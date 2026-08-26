/**
 * Capture state machine tests.
 *
 * Driven through `ReplaySource` and `CubeTracker` from `cube-link` — the same path a real cube
 * takes — so these exercise the wiring rather than the machine in isolation. `ReplaySource`
 * can reproduce BLE batching, clock skew and dropped packets on demand, which is what makes
 * the awkward cases testable without hardware.
 */
import { describe, expect, it } from "vitest";
import {
  applyMoves,
  CubeState,
  invertMoves,
  parseMoves,
  toFacelets,
} from "@cubing-companion/engine";
import {
  CubeTracker,
  recordingFromAlg,
  ReplaySource,
} from "@cubing-companion/cube-link";
import { SolveRecorder } from "../src/recorder.ts";
import type { SolveRecord } from "../src/types.ts";

const SCRAMBLE = "D2 F R2 U' L B2 R'";

/**
 * A recorder wired to a replay source through a tracker, exactly as the app wires it.
 *
 * `handleMove` runs before `handleState` so that the move which solves the cube is counted as
 * part of the solve rather than arriving after it has ended.
 */
async function harness(options: {
  /** Position the cube starts in. */
  start?: CubeState;
  /** Moves the source will play. */
  moves: string;
  scramble?: string | null;
} ) {
  const source = new ReplaySource(recordingFromAlg(options.moves, { intervalMs: 150 }), {
    ...(options.start ? { initialState: options.start } : {}),
  });
  const tracker = new CubeTracker(source, { verifyIntervalMs: 0 });
  let counter = 0;
  const recorder = new SolveRecorder({
    sessionId: "test-session",
    source: "replay",
    now: () => 1_000 + counter,
    makeId: () => `solve-${++counter}`,
  });

  tracker.onMove((move) => {
    recorder.handleMove(move);
    recorder.handleState(tracker.getState());
  });

  await tracker.start();
  return { source, tracker, recorder };
}

const scrambledState = (scramble: string) =>
  applyMoves(CubeState.solved(), parseMoves(scramble));

describe("arming and readiness", () => {
  it("starts idle", () => {
    const recorder = new SolveRecorder({ sessionId: "s", source: "manual" });
    expect(recorder.getState().phase).toBe("idle");
  });

  it("waits for the cube to reach the scramble", async () => {
    const { source, tracker, recorder } = await harness({ moves: SCRAMBLE });
    recorder.arm(SCRAMBLE, tracker.getState());
    expect(recorder.getState().phase).toBe("scrambling");

    // Part-way through applying it, still scrambling.
    source.step();
    source.step();
    expect(recorder.getState().phase).toBe("scrambling");

    source.stepAll();
    expect(recorder.getState().phase).toBe("ready");
  });

  it("starts the solve on the first turn after the scramble is reached", async () => {
    // Deliberately *not* trying to tell a false start from a real one: the first move of a
    // genuine solve leaves the target position exactly as fiddling does, so from state alone
    // they are the same observation. Discard is the remedy.
    const { source, tracker, recorder } = await harness({ moves: `${SCRAMBLE} U` });
    recorder.arm(SCRAMBLE, tracker.getState());
    for (let i = 0; i < parseMoves(SCRAMBLE).length; i++) source.step();
    expect(recorder.getState().phase).toBe("ready");

    source.step();
    expect(recorder.getState().phase).toBe("solving");
    expect(recorder.getState().moveCount).toBe(1);
  });

  it("is ready at once when the cube already matches", async () => {
    // Arming a correctly scrambled cube must not wait for a move that would itself be the
    // start of the solve.
    const start = scrambledState(SCRAMBLE);
    const { tracker, recorder } = await harness({ start, moves: "R" });
    recorder.arm(SCRAMBLE, tracker.getState());
    expect(recorder.getState().phase).toBe("ready");
  });

  it("can begin from wherever the cube is", async () => {
    // A mis-scramble must not leave the solver stuck waiting for a match.
    const start = scrambledState("R U F");
    const { recorder, tracker } = await harness({ start, moves: "R" });
    recorder.arm(SCRAMBLE, tracker.getState());
    expect(recorder.getState().phase).toBe("scrambling");

    recorder.startFrom(tracker.getState());
    expect(recorder.getState().phase).toBe("ready");
  });
});

describe("recording a solve", () => {
  /** Scramble the cube, arm, then solve it — the full cycle. */
  async function fullSolve() {
    const start = scrambledState(SCRAMBLE);
    const solution = invertMoves(parseMoves(SCRAMBLE));
    const { source, tracker, recorder } = await harness({
      start,
      moves: solution.map((m) => `${m.family}${m.amount === 1 ? "" : m.amount === 2 ? "2" : "'"}`).join(" "),
    });
    recorder.arm(SCRAMBLE, tracker.getState());
    expect(recorder.getState().phase).toBe("ready");
    source.stepAll();
    return recorder;
  }

  it("starts on the first move and ends when the cube is solved", async () => {
    const recorder = await fullSolve();
    const state = recorder.getState();
    expect(state.phase).toBe("complete");
    expect(state.record).not.toBeNull();
    expect(state.record!.outcome).toBe("solved");
  });

  it("records the position it started from, not the scramble text", async () => {
    const recorder = await fullSolve();
    const record = recorder.getState().record!;
    // The authoritative field: what the cube actually showed.
    expect(record.startFacelets).toBe(toFacelets(scrambledState(SCRAMBLE)));
    // The scramble is kept for display, and flagged as having matched.
    expect(record.scrambleText).toBe(SCRAMBLE);
    expect(record.scrambleMatched).toBe(true);
  });

  it("records every move of the solve and nothing before it", async () => {
    const recorder = await fullSolve();
    const record = recorder.getState().record!;
    expect(record.moveCount).toBe(parseMoves(SCRAMBLE).length);
    // The recorded solution really does solve the recorded start position.
    const solved = applyMoves(
      applyMoves(CubeState.solved(), parseMoves(SCRAMBLE)),
      parseMoves(record.solution),
    );
    expect(solved.isSolved()).toBe(true);
  });

  it("times from the first move to the last", async () => {
    const recorder = await fullSolve();
    const record = recorder.getState().record!;
    // Seven moves at 150ms spacing: six intervals.
    expect(record.durationMs).toBeCloseTo(150 * (record.moveCount - 1), 3);
    expect(record.tps).toBeGreaterThan(0);
  });

  it("refuses timing that no hand could have produced", async () => {
    // Pasted algorithms and replays land every move within a millisecond, which would report a
    // sub-second solve at thousands of turns per second. Reporting nothing is the honest
    // answer, and it keeps fiction out of A3.
    const start = scrambledState(SCRAMBLE);
    const solutionText = invertMoves(parseMoves(SCRAMBLE))
      .map((m) => `${m.family}${m.amount === 1 ? "" : m.amount === 2 ? "2" : "'"}`)
      .join(" ");
    const source = new ReplaySource(
      // One move per millisecond: far past any human turn rate.
      recordingFromAlg(solutionText, { intervalMs: 1 }),
      { initialState: start },
    );
    const tracker = new CubeTracker(source, { verifyIntervalMs: 0 });
    const recorder = new SolveRecorder({ sessionId: "s", source: "manual" });
    tracker.onMove((move) => {
      recorder.handleMove(move);
      recorder.handleState(tracker.getState());
    });
    await tracker.start();
    recorder.arm(SCRAMBLE, tracker.getState());
    source.stepAll();

    const record = recorder.getState().record!;
    expect(record.durationMs).toBeNull();
    expect(record.tps).toBeNull();
    // The moves themselves are still recorded; only the timing is withheld — including the
    // per-move timestamps, so phase durations cannot report a confident zero either.
    expect(record.moveCount).toBe(parseMoves(SCRAMBLE).length);
    expect(record.moveTimestamps.every((t) => t === null)).toBe(true);
  });

  it("does not mark an unmatched scramble as matched", async () => {
    const start = scrambledState("R U F");
    const solution = invertMoves(parseMoves("R U F"));
    const { source, recorder, tracker } = await harness({
      start,
      moves: solution.map((m) => `${m.family}${m.amount === 1 ? "" : m.amount === 2 ? "2" : "'"}`).join(" "),
    });
    recorder.arm(SCRAMBLE, tracker.getState()); // a different scramble entirely
    recorder.startFrom(tracker.getState());
    source.stepAll();

    const record = recorder.getState().record!;
    expect(record.scrambleMatched).toBe(false);
    expect(record.startFacelets).toBe(toFacelets(start));
  });
});

describe("timestamps", () => {
  it("places every move once the solve is finished", async () => {
    // Live, the opening moves of a batched stream cannot be placed — no host timestamp has
    // arrived to anchor the cube clock. Completing the solve runs the batch retime, which can.
    const start = scrambledState(SCRAMBLE);
    const solutionText = invertMoves(parseMoves(SCRAMBLE))
      .map((m) => `${m.family}${m.amount === 1 ? "" : m.amount === 2 ? "2" : "'"}`)
      .join(" ");
    const source = new ReplaySource(
      recordingFromAlg(solutionText, {
        intervalMs: 150,
        batchSize: 3, // only every third move carries a host timestamp
        cubeClockRate: 1.02,
      }),
      { initialState: start },
    );
    const tracker = new CubeTracker(source, { verifyIntervalMs: 0 });
    const recorder = new SolveRecorder({ sessionId: "s", source: "smart-cube" });
    tracker.onMove((move) => {
      recorder.handleMove(move);
      recorder.handleState(tracker.getState());
    });
    await tracker.start();
    recorder.arm(SCRAMBLE, tracker.getState());
    source.stepAll();

    const record = recorder.getState().record!;
    expect(record.moveTimestamps).toHaveLength(record.moveCount);
    expect(record.moveTimestamps.every((t) => t !== null)).toBe(true);
    expect(record.durationMs).toBeCloseTo(150 * (record.moveCount - 1), 0);
  });
});

describe("discarding", () => {
  it("keeps a discarded solve as a record", async () => {
    const start = scrambledState(SCRAMBLE);
    const { source, tracker, recorder } = await harness({ start, moves: "R U" });
    recorder.arm(SCRAMBLE, tracker.getState());
    source.step();
    expect(recorder.getState().phase).toBe("solving");

    const record = recorder.discard();
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe("discarded");
    expect(recorder.getState().phase).toBe("complete");
  });

  it("has nothing to discard before a solve starts", () => {
    const recorder = new SolveRecorder({ sessionId: "s", source: "manual" });
    recorder.arm(SCRAMBLE, CubeState.solved());
    expect(recorder.discard()).toBeNull();
  });

  it("returns to idle on reset", async () => {
    const start = scrambledState(SCRAMBLE);
    const { source, tracker, recorder } = await harness({ start, moves: "R U" });
    recorder.arm(SCRAMBLE, tracker.getState());
    source.step();
    recorder.reset();
    const state = recorder.getState();
    expect(state.phase).toBe("idle");
    expect(state.moveCount).toBe(0);
    expect(state.record).toBeNull();
    expect(state.scrambleText).toBeNull();
  });
});

describe("record shape", () => {
  it("is plain JSON, so it survives storage and a trip to a server", async () => {
    const start = scrambledState(SCRAMBLE);
    const solutionText = invertMoves(parseMoves(SCRAMBLE))
      .map((m) => `${m.family}${m.amount === 1 ? "" : m.amount === 2 ? "2" : "'"}`)
      .join(" ");
    const { source, tracker, recorder } = await harness({ start, moves: solutionText });
    recorder.arm(SCRAMBLE, tracker.getState());
    source.stepAll();

    const record = recorder.getState().record!;
    const roundTripped = JSON.parse(JSON.stringify(record)) as SolveRecord;
    expect(roundTripped).toEqual(record);
    // No typed arrays or class instances leaked into the record.
    expect(typeof record.startFacelets).toBe("string");
    expect(typeof record.solution).toBe("string");
  });
});

/**
 * Rotations before the first turn are inspection, not solving.
 *
 * Under WCA rules the 15 seconds of inspection are where you decide how to hold the cube, and a
 * rotation changes nothing about the cube's state — so neither the move count nor the clock
 * should include them. The corpus agrees about what they are for: pros rotate 1.45 times before
 * their first turn and only 0.23 times across the whole cross.
 */
describe("inspection rotations", () => {
  const SOLUTION = "R U R' U' R U R' U'";

  it("are left out of the move count", async () => {
    const plain = await harness({ start: scrambledState(SCRAMBLE), moves: SOLUTION });
    plain.recorder.arm(SCRAMBLE, plain.tracker.getState());
    plain.source.stepAll();

    const rotated = await harness({
      start: scrambledState(SCRAMBLE),
      moves: `y x' ${SOLUTION}`,
    });
    rotated.recorder.arm(SCRAMBLE, rotated.tracker.getState());
    rotated.source.stepAll();

    // Two rotations up front, and the same number of moves reported.
    expect(rotated.recorder.getState().moveCount).toBe(
      plain.recorder.getState().moveCount,
    );
  });

  it("stay in the solution, because the grip they chose is worth knowing", async () => {
    const { source, tracker, recorder } = await harness({
      start: scrambledState(SCRAMBLE),
      moves: `y ${SOLUTION}`,
    });
    recorder.arm(SCRAMBLE, tracker.getState());
    source.stepAll();
    recorder.discard();

    const record = recorder.getState().record!;
    // A4 recommends a grip and B3 models it; throwing the rotation away would lose that.
    expect(record.solution.startsWith("y ")).toBe(true);
    expect(record.moveCount).toBe(parseMoves(SOLUTION).length);
  });

  it("do not start the clock", async () => {
    // The replay spaces moves 150 ms apart, so two leading rotations would add 300 ms to any
    // duration that counted them.
    const plain = await harness({ start: scrambledState(SCRAMBLE), moves: SOLUTION });
    plain.recorder.arm(SCRAMBLE, plain.tracker.getState());
    plain.source.stepAll();
    plain.recorder.discard();

    const rotated = await harness({
      start: scrambledState(SCRAMBLE),
      moves: `y x' ${SOLUTION}`,
    });
    rotated.recorder.arm(SCRAMBLE, rotated.tracker.getState());
    rotated.source.stepAll();
    rotated.recorder.discard();

    expect(rotated.recorder.getState().record!.durationMs).toBe(
      plain.recorder.getState().record!.durationMs,
    );
  });

  it("leave a mid-solve rotation alone, which really did cost time", async () => {
    // Only the leading run is inspection. A rotation in the middle is a regrip you paid for.
    const { source, tracker, recorder } = await harness({
      start: scrambledState(SCRAMBLE),
      moves: "R U y R' U' R U R' U'",
    });
    recorder.arm(SCRAMBLE, tracker.getState());
    source.stepAll();
    recorder.discard();

    const record = recorder.getState().record!;
    expect(record.moveCount).toBe(9);
  });
});
