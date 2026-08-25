/**
 * Joining stored records to the segmenter.
 *
 * This is where A2's two halves meet: a solve captured from a cube becomes a solve broken into
 * CFOP phases. The interesting property is that it works from `startFacelets` alone, so a
 * mis-scrambled solve analyses correctly rather than being judged against a scramble the cube
 * never reached.
 */
import { describe, expect, it } from "vitest";
import {
  applyMoves,
  CubeState,
  invertMoves,
  parseMoves,
  serializeMoves,
  toFacelets,
} from "@cubing-companion/engine";
import { Phase } from "@cubing-companion/analysis";
import { segmentRecord } from "../src/segmented.ts";
import type { SolveRecord } from "../src/types.ts";

const CROSS = "F2 R2 D2 L B2";
const F2L = "R U' R' U  L' U L  U2 B U B'  y2 R U R' y2'";
const OLL = "R U R' U R U2 R'";
const PLL = "R U R' U' R' F R2 U' R' U' R U R' F'";
const SOLUTION = `${CROSS} ${F2L} ${OLL} ${PLL}`;

/** A record for a solve whose solution is `SOLUTION`, started from its inverse. */
function record(overrides: Partial<SolveRecord> = {}): SolveRecord {
  const moves = parseMoves(SOLUTION);
  const start = applyMoves(CubeState.solved(), invertMoves(moves));
  return {
    id: "a",
    sessionId: "s",
    startedAt: 0,
    startFacelets: toFacelets(start),
    scrambleText: serializeMoves(invertMoves(moves)),
    scrambleMatched: true,
    solution: SOLUTION,
    moveCount: moves.length,
    durationMs: (moves.length - 1) * 100,
    tps: 5,
    source: "manual",
    outcome: "solved",
    // One move every 100ms, so phase durations are trivially checkable.
    moveTimestamps: moves.map((_, i) => i * 100),
    ...overrides,
  };
}

describe("segmenting a stored record", () => {
  it("segments from the stored position", () => {
    const { segmentation } = segmentRecord(record());
    expect(segmentation.failure).toBeNull();
    expect(segmentation.segmentation!.spans.map((s) => s.phase)).toEqual([
      Phase.Cross,
      Phase.F2L1,
      Phase.F2L2,
      Phase.F2L3,
      Phase.F2L4,
      Phase.OLL,
      Phase.PLL,
      Phase.AUF,
    ]);
  });

  it("does not need the scramble text at all", () => {
    // The point of storing the position: a solve with no scramble, or a wrong one, still
    // analyses correctly.
    const withoutScramble = segmentRecord(
      record({ scrambleText: null, scrambleMatched: false }),
    );
    const withScramble = segmentRecord(record());
    expect(withoutScramble.segmentation.segmentation!.spans).toEqual(
      withScramble.segmentation.segmentation!.spans,
    );
  });

  it("is unaffected by a scramble text that does not match the position", () => {
    const misleading = segmentRecord(
      record({ scrambleText: "R U F", scrambleMatched: false }),
    );
    expect(misleading.segmentation.failure).toBeNull();
    expect(misleading.segmentation.segmentation!.crossFace).toBe(
      segmentRecord(record()).segmentation.segmentation!.crossFace,
    );
  });

  it("gives each phase a duration", () => {
    const { segmentation, phaseDurations } = segmentRecord(record());
    const spans = segmentation.segmentation!.spans;
    expect(phaseDurations).toHaveLength(spans.length);

    // The first phase is measured differently from the rest, and necessarily so: a phase
    // lasts from the previous move landing to its own last move, but the first phase has no
    // previous move. It therefore covers n-1 intervals across n moves, where every later
    // phase covers n. That asymmetry is what makes the durations sum to the solve time.
    spans.forEach((span, i) => {
      if (span.end === span.start) {
        expect(phaseDurations[i], span.phase).toBe(0);
        return;
      }
      const intervals = i === 0 ? span.end - span.start - 1 : span.end - span.start;
      expect(phaseDurations[i], span.phase).toBe(intervals * 100);
    });
  });

  it("adds the phase durations up to the solve duration", () => {
    const { phaseDurations, record: stored } = segmentRecord(record());
    const total = phaseDurations.reduce<number>((sum, d) => sum + (d ?? 0), 0);
    expect(total).toBe(stored.durationMs);
  });

  it("reports a null duration where a phase has no usable timestamps", () => {
    // Real streams can leave the opening moves unplaced even after retiming, if no host
    // timestamp arrived early enough to anchor the cube clock.
    const moves = parseMoves(SOLUTION);
    const gappy = record({
      moveTimestamps: moves.map((_, i) => (i < 6 ? null : i * 100)),
    });
    const { phaseDurations } = segmentRecord(gappy);
    expect(phaseDurations[0]).toBeNull(); // cross, entirely inside the gap
    expect(phaseDurations.at(-2)).not.toBeNull(); // PLL, well clear of it
  });

  it("passes a segmentation failure through rather than throwing", () => {
    const broken = segmentRecord(record({ solution: "R U" }));
    expect(broken.segmentation.segmentation).toBeNull();
    expect(broken.segmentation.failure).toBe("does-not-solve");
    expect(broken.phaseDurations).toEqual([]);
  });
});
