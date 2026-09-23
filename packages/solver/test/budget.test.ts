/**
 * Deadlines, and the sampling that makes them affordable.
 *
 * Tested with an injected clock rather than by sleeping. A test that waits for real milliseconds
 * is slow, and worse, flaky on a loaded machine — which for a *timing* feature means the test
 * fails for exactly the reason the feature exists.
 */
import { describe, expect, it } from "vitest";
import { applyMoves, CubeState, Face, parseMoves } from "@cubing-companion/engine";
import { budgetFor } from "../src/budget.ts";
import { enumerateCross } from "../src/cross.ts";

/** A clock the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("budgetFor", () => {
  it("never expires without a deadline", () => {
    const budget = budgetFor(undefined);
    expect(budget.expired(0)).toBe(false);
    expect(budget.expired(1_000_000)).toBe(false);
  });

  it("expires once the clock passes the deadline", () => {
    const time = clock();
    const budget = budgetFor(100, time.now);

    expect(budget.expired(0)).toBe(false);
    time.advance(150);
    // Not at node 0 — the clock is only read on a sampling boundary.
    expect(budget.expired(10_000)).toBe(true);
  });

  it("stays expired once it has expired", () => {
    // Otherwise a search could resume after its deadline simply by counting more nodes.
    const time = clock();
    const budget = budgetFor(100, time.now);
    time.advance(150);
    expect(budget.expired(10_000)).toBe(true);
    expect(budget.expired(10_001)).toBe(true);
  });

  it("reads the clock only occasionally", () => {
    // The point of sampling: a clock read costs more than the node it guards, so reading per node
    // would make the budget its own bottleneck.
    let reads = 0;
    const budget = budgetFor(100, () => {
      reads++;
      return 1000;
    });
    // One read to set the deadline, then one per sampling window.
    for (let node = 0; node < 20_000; node++) budget.expired(node);
    expect(reads).toBeLessThan(10);
  });

  it("treats a non-positive deadline as no time at all", () => {
    const time = clock();
    expect(budgetFor(0, time.now).expired(0)).toBe(true);
    expect(budgetFor(-5, time.now).expired(0)).toBe(true);
  });

  it("ignores a non-finite deadline rather than expiring immediately", () => {
    expect(budgetFor(Infinity).expired(10_000)).toBe(false);
    expect(budgetFor(Number.NaN).expired(10_000)).toBe(false);
  });
});

describe("a search under a deadline", () => {
  const scrambled = applyMoves(CubeState.solved(), parseMoves("B U2 R2 D L' R2 L' D2 R2"));

  it("returns immediately, and says it was truncated", () => {
    const result = enumerateCross(scrambled, Face.D, { deadlineMs: 0, maxExtra: 3 });
    expect(result.stats.truncated).toBe(true);
  });

  it("is exhaustive when given time", () => {
    const result = enumerateCross(scrambled, Face.D, { maxExtra: 0 });
    expect(result.stats.truncated).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("still honours maxNodes, so benchmarks stay reproducible", () => {
    // Both limits may be given; whichever bites first stops the search. `maxNodes` has to keep
    // working on its own, because it is the one that makes a measurement comparable across
    // devices — which is the whole reason `deadlineMs` exists as a separate knob.
    const result = enumerateCross(scrambled, Face.D, { maxNodes: 50, maxExtra: 3 });
    expect(result.stats.nodes).toBeLessThanOrEqual(50 + 4096);
    expect(result.stats.truncated).toBe(true);
  });
});
