/**
 * Manual and replay sources.
 *
 * The interface contract matters as much as the behaviour: if these two and the smart cube
 * are not interchangeable, then the "input-agnostic analysis" the plan calls for is not
 * real, and A2/A3 will end up branching on source type.
 */
import { describe, expect, it } from "vitest";
import {
  NotationError,
  parseMoves,
  stateAfter,
  toFacelets,
} from "@cubing-companion/engine";
import { DEFAULT_KEY_MAP, ManualSource } from "../src/manual.ts";
import { recordingFromAlg, ReplaySource } from "../src/replay.ts";
import type { CubeSource, MoveEvent } from "../src/source.ts";

describe("manual input", () => {
  it("applies pasted algorithms", async () => {
    const source = new ManualSource();
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));

    source.applyAlg("R U R' U'");
    expect(moves).toHaveLength(4);
    expect(toFacelets(await source.queryState())).toBe(
      toFacelets(stateAfter(parseMoves("R U R' U'"))),
    );
  });

  it("accepts a whole pasted reconstruction, comments and all", () => {
    const source = new ManualSource();
    const moves = source.applyAlg("x2 // inspection\nR U R' // cross");
    expect(moves).toHaveLength(4);
  });

  it("surfaces bad notation rather than silently ignoring it", () => {
    const source = new ManualSource();
    expect(() => source.applyAlg("R U (Q'")).toThrow(NotationError);
  });

  it("maps keys to moves", async () => {
    const source = new ManualSource();
    expect(source.pressKey("j")).toBe(true);
    expect(toFacelets(await source.queryState())).toBe(
      toFacelets(stateAfter(parseMoves("U"))),
    );
  });

  it("ignores unbound keys instead of throwing", () => {
    // This sits under a keydown handler, where most keys are not cube moves.
    const source = new ManualSource();
    expect(source.pressKey("§")).toBe(false);
    expect(source.pressKey("Enter")).toBe(false);
  });

  it("binds every key to notation the engine understands", () => {
    for (const [key, notation] of Object.entries(DEFAULT_KEY_MAP)) {
      expect(() => parseMoves(notation), `${key} -> ${notation}`).not.toThrow();
      expect(parseMoves(notation), `${key} -> ${notation}`).toHaveLength(1);
    }
  });

  it("pairs each face with its inverse", () => {
    const notations = Object.values(DEFAULT_KEY_MAP);
    for (const family of ["U", "F", "R", "L", "D", "B", "x", "y", "z"]) {
      expect(notations, family).toContain(family);
      expect(notations, `${family}'`).toContain(`${family}'`);
    }
  });

  it("puts x on y and b, and Lw on v", () => {
    // Note the two namespaces: the *key* `y` produces the *move* `x`. The move `y` lives
    // on `;` and is unaffected.
    expect(DEFAULT_KEY_MAP.y).toBe("x");
    expect(DEFAULT_KEY_MAP.b).toBe("x'");
    expect(DEFAULT_KEY_MAP.v).toBe("Lw");
    expect(DEFAULT_KEY_MAP[";"]).toBe("y");
  });

  it("actually turns the cube for the rebound keys", async () => {
    for (const [key, alg] of [
      ["y", "x"],
      ["b", "x'"],
      ["v", "Lw"],
    ] as const) {
      const source = new ManualSource();
      expect(source.pressKey(key), key).toBe(true);
      expect(toFacelets(await source.queryState()), `${key} -> ${alg}`).toBe(
        toFacelets(stateAfter(parseMoves(alg))),
      );
    }
  });

  it("advances serials so the tracker sees a healthy stream", () => {
    const source = new ManualSource();
    const serials: number[] = [];
    source.onMove((m) => serials.push(m.serial));
    source.applyAlg("R U R' U'");
    expect(serials).toEqual([1, 2, 3, 4]);
  });

  it("has no cube clock, and says so", () => {
    // Manual input must not pretend to a precision it does not have.
    const source = new ManualSource({ now: () => 1234 });
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));
    source.applyAlg("R");
    expect(moves[0]!.cubeTimestamp).toBeNull();
    expect(moves[0]!.localTimestamp).toBe(1234);
  });

  it("resets to solved", async () => {
    const source = new ManualSource();
    source.applyAlg("R U R'");
    source.reset();
    expect((await source.queryState()).isSolved()).toBe(true);
  });
});

describe("replay", () => {
  it("builds a recording that batches host timestamps like a real cube", () => {
    const recording = recordingFromAlg("R U R' U' R U", { batchSize: 3 });
    expect(recording).toHaveLength(6);
    // Within each batch of three, only the last carries a host timestamp.
    expect(recording.map((r) => r.localTimestamp !== null)).toEqual([
      false, false, true, false, false, true,
    ]);
    expect(recording.every((r) => r.cubeTimestamp !== null)).toBe(true);
  });

  it("scales the cube clock to simulate skew", () => {
    const recording = recordingFromAlg("R U R'", {
      intervalMs: 100,
      cubeClockRate: 1.05,
      cubeEpoch: 0,
    });
    expect(recording[2]!.cubeTimestamp).toBeCloseTo(210, 6);
  });

  it("emits moves one at a time, deterministically", async () => {
    const source = new ReplaySource(recordingFromAlg("R U R'"));
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));

    expect(source.remaining).toBe(3);
    expect(source.step()).toBe(true);
    expect(moves).toHaveLength(1);
    expect(source.stepAll()).toBe(2);
    expect(source.hasMore).toBe(false);
    expect(source.step()).toBe(false);
  });

  it("tracks the cube state as it plays", async () => {
    const source = new ReplaySource(recordingFromAlg("R U R' U'"));
    source.stepAll();
    expect(toFacelets(await source.queryState())).toBe(
      toFacelets(stateAfter(parseMoves("R U R' U'"))),
    );
  });

  it("can turn the cube without telling anyone", async () => {
    // Simulates the cube being turned while the page is backgrounded or disconnected.
    const source = new ReplaySource(recordingFromAlg("R"));
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));

    source.applySilently("F2 D'");
    expect(moves).toEqual([]);
    expect(toFacelets(await source.queryState())).toBe(
      toFacelets(stateAfter(parseMoves("F2 D'"))),
    );
  });

  it("can drop serials to simulate lost packets", () => {
    const source = new ReplaySource(recordingFromAlg("R U R'"), { dropSerials: 2 });
    const serials: number[] = [];
    source.onMove((m) => serials.push(m.serial));
    source.stepAll();
    expect(serials).toEqual([3, 6, 9]);
  });
});

describe("interface parity", () => {
  // If these diverge, downstream code starts caring which source it has, and the
  // input-agnostic design stops being true.
  const sources: [string, () => CubeSource][] = [
    ["manual", () => new ManualSource()],
    ["replay", () => new ReplaySource(recordingFromAlg("R U"))],
  ];

  for (const [name, make] of sources) {
    it(`${name} satisfies the CubeSource contract`, async () => {
      const source = make();
      expect(typeof source.kind).toBe("string");
      expect(await source.queryState()).toBeDefined();

      let disconnects = 0;
      const unsubscribe = source.onDisconnect(() => disconnects++);
      const unsubscribeMove = source.onMove(() => {});
      expect(typeof unsubscribe).toBe("function");
      expect(typeof unsubscribeMove).toBe("function");

      await source.disconnect();
      await source.disconnect(); // idempotent
      expect(disconnects).toBe(1);

      unsubscribe();
      unsubscribeMove();
    });

    it(`${name} stops notifying after unsubscribe`, () => {
      const source = make();
      let count = 0;
      const unsubscribe = source.onMove(() => count++);
      unsubscribe();
      if (source instanceof ManualSource) source.applyAlg("R");
      if (source instanceof ReplaySource) source.step();
      expect(count).toBe(0);
    });
  }
});
