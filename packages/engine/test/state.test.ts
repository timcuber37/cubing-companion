import { describe, expect, it } from "vitest";
import {
  CORNER_NAMES,
  CubeState,
  EDGE_NAMES,
  CENTER_NAMES,
  STATE_BYTES,
} from "../src/state.ts";
import { parseMoves } from "../src/notation.ts";
import { applyMoveInPlace, stateAfter, type Move } from "../src/moves.ts";

describe("CubeState", () => {
  it("packs the whole state into one 46-byte buffer", () => {
    expect(STATE_BYTES).toBe(46);
    expect(CubeState.solved().bytes.length).toBe(46);
  });

  it("exposes its arrays as views onto that buffer", () => {
    const state = CubeState.solved();
    state.cp[0] = 7;
    expect(state.bytes[0]).toBe(7);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => new CubeState(new Uint8Array(10))).toThrow(RangeError);
    expect(() => new CubeState(new Uint8Array(47))).toThrow(RangeError);
  });

  it("clones without sharing storage", () => {
    const original = stateAfter(parseMoves("R U R'"));
    const copy = original.clone();
    expect(copy.equals(original)).toBe(true);
    applyMoveInPlace(copy, { family: "U", amount: 1 });
    expect(copy.equals(original)).toBe(false);
  });

  it("copies from another state in place", () => {
    const target = CubeState.solved();
    const source = stateAfter(parseMoves("R U R'"));
    target.copyFrom(source);
    expect(target.equals(source)).toBe(true);
    expect(target.bytes).not.toBe(source.bytes);
  });

  it("gives equal states equal keys, and different states different keys", () => {
    expect(stateAfter(parseMoves("R U")).key()).toBe(
      stateAfter(parseMoves("R U")).key(),
    );
    expect(stateAfter(parseMoves("R U")).key()).not.toBe(
      stateAfter(parseMoves("R U'")).key(),
    );
  });

  it("names every piece slot exactly once", () => {
    expect(CORNER_NAMES).toHaveLength(8);
    expect(EDGE_NAMES).toHaveLength(12);
    expect(CENTER_NAMES).toHaveLength(6);
    expect(new Set(CORNER_NAMES).size).toBe(8);
    expect(new Set(EDGE_NAMES).size).toBe(12);
    expect(new Set(CENTER_NAMES).size).toBe(6);
  });
});

describe("defensive errors", () => {
  it("throws when applying a move with an unmodelled family", () => {
    // Reachable only by bypassing `makeMove`, but worth failing loudly rather than
    // silently applying nothing.
    const bogus = { family: "Q", amount: 1 } as unknown as Move;
    expect(() => applyMoveInPlace(CubeState.solved(), bogus)).toThrow(
      /unknown move family/,
    );
  });
});
