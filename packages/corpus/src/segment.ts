/**
 * Turn an annotated solution into verified, classified phase segments.
 *
 * Segmentation here comes from the reconstructor's own `// label` annotations rather than
 * from state predicates. That is a deliberate shortcut with a real payoff: it means B1
 * does not depend on the A2 segmenter, and it produces a **human-labelled ground-truth
 * set** that A2 can later be validated against — which is a far better position than
 * having the segmenter be its own judge.
 */
import {
  isSolvedIgnoringOrientation,
  NotationError,
  parseMoves,
  stateAfter,
  type Move,
} from "@cubing-companion/engine";
import { classifyMethod, normalizeLabel } from "./labels.ts";
import {
  F2L_PHASES,
  Method,
  Phase,
  type Quality,
  type RawSolve,
  type Segment,
  type SolveRecord,
} from "./types.ts";

const ROTATIONS = new Set(["x", "y", "z"]);

/**
 * Repair an unambiguous typo: a prime immediately followed by a letter, as in `U'F`.
 *
 * A prime always terminates a move and there is no family beginning with `'`, so `U' F`
 * is the only possible reading — this cannot change a solve's meaning, only make an
 * unparseable one parseable. Observed in real reconstructions (Mats Valk's 7.13 writes
 * `y' U'F R' F' R`).
 *
 * Applied only after a parse failure, and the result is still required to verify against
 * the engine, so a repair can never introduce a solve that does not actually solve.
 */
function repairSpacing(text: string): string {
  return text.replace(/'(?=[A-Za-z])/g, "' ");
}

/** Parse, retrying once with spacing repaired. Reports whether the repair was needed. */
function parseWithRepair(text: string): { moves: Move[]; repaired: boolean } {
  try {
    return { moves: parseMoves(text), repaired: false };
  } catch (cause) {
    const candidate = repairSpacing(text);
    if (candidate === text) throw cause;
    return { moves: parseMoves(candidate), repaired: true };
  }
}

const countRotations = (moves: readonly Move[]) =>
  moves.filter((m) => ROTATIONS.has(m.family)).length;

/** Split an annotated solution into `{ label, moveText }` lines, dropping blanks. */
export function splitAnnotatedLines(
  solution: string,
): { label: string; moveText: string }[] {
  const lines: { label: string; moveText: string }[] = [];
  for (const line of solution.split("\n")) {
    const commentAt = line.indexOf("//");
    const moveText = (commentAt === -1 ? line : line.slice(0, commentAt)).trim();
    const label = commentAt === -1 ? "" : line.slice(commentAt + 2).trim();
    if (moveText === "" && label === "") continue;
    lines.push({ label, moveText });
  }
  return lines;
}

/** Every label a solution carries, in order. */
export function labelsOf(solution: string): string[] {
  return splitAnnotatedLines(solution)
    .map((l) => l.label)
    .filter((l) => l !== "");
}

export interface SegmentationResult {
  readonly record: SolveRecord | null;
  readonly error: { reason: "unparseable-notation" | "does-not-solve" | "no-segments"; detail: string } | null;
  /** Labels this solve used that the normalizer did not recognize. */
  readonly unknownLabels: readonly string[];
}

/**
 * Determine segmentation quality.
 *
 * `clean` requires every CFOP phase to appear exactly once across unmerged segments —
 * those are the solves per-phase distributions can be built from. Merged solves still
 * count toward whole-solve statistics.
 */
function assessQuality(segments: readonly Segment[]): Quality {
  if (segments.some((s) => s.merged)) return "merged";

  const counts = new Map<Phase, number>();
  for (const segment of segments) {
    for (const phase of segment.phases) {
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
  }

  const required = [Phase.Cross, ...F2L_PHASES];
  const everyRequiredOnce = required.every((p) => counts.get(p) === 1);
  const hasLastLayer =
    (counts.get(Phase.OLL) ?? 0) + (counts.get(Phase.PLL) ?? 0) > 0 ||
    (counts.get(Phase.LastLayer) ?? 0) > 0;
  const noUnknown = !counts.has(Phase.Unknown);

  return everyRequiredOnce && hasLastLayer && noUnknown ? "clean" : "partial";
}

/**
 * Parse, verify, and segment a raw solve.
 *
 * Verification applies scramble + the full solution to a solved cube and checks it
 * returns to solved, allowing for whole-cube rotation — a solve ending after `x2` is
 * solved, just not in the orientation it started in.
 */
export function segmentSolve(raw: RawSolve): SegmentationResult {
  const lines = splitAnnotatedLines(raw.solution);
  if (lines.length === 0) {
    return {
      record: null,
      error: { reason: "no-segments", detail: "solution had no move lines" },
      unknownLabels: [],
    };
  }

  const segments: Segment[] = [];
  const unknownLabels: string[] = [];
  const allMoves: Move[] = [];
  let repaired = false;

  try {
    for (const { label, moveText } of lines) {
      let moves: Move[] = [];
      if (moveText !== "") {
        const parsed = parseWithRepair(moveText);
        moves = parsed.moves;
        repaired ||= parsed.repaired;
      }
      allMoves.push(...moves);
      if (moves.length === 0) continue;

      const normalized = normalizeLabel(label);
      if (!normalized.recognized && label !== "") unknownLabels.push(label);

      segments.push({
        rawLabel: label,
        phases: normalized.phases,
        merged: normalized.merged,
        moves,
        turns: moves.length - countRotations(moves),
        rotations: countRotations(moves),
      });
    }
  } catch (cause) {
    return {
      record: null,
      error: {
        reason: "unparseable-notation",
        detail: cause instanceof NotationError ? cause.message : String(cause),
      },
      unknownLabels,
    };
  }

  if (segments.length === 0) {
    return {
      record: null,
      error: { reason: "no-segments", detail: "no segment contained moves" },
      unknownLabels,
    };
  }

  let scrambleMoves: Move[];
  try {
    const parsed = parseWithRepair(raw.scramble);
    scrambleMoves = parsed.moves;
    repaired ||= parsed.repaired;
  } catch (cause) {
    return {
      record: null,
      error: {
        reason: "unparseable-notation",
        detail: `scramble: ${cause instanceof NotationError ? cause.message : String(cause)}`,
      },
      unknownLabels,
    };
  }

  const verified = isSolvedIgnoringOrientation(
    stateAfter([...scrambleMoves, ...allMoves]),
  );
  if (!verified) {
    return {
      record: null,
      error: {
        reason: "does-not-solve",
        detail: "scramble + solution does not return to solved",
      },
      unknownLabels,
    };
  }

  const method = classifyMethod(labelsOf(raw.solution));

  return {
    record: {
      ...raw,
      method,
      segments,
      verified,
      repaired,
      quality: assessQuality(segments),
      totalTurns: segments.reduce((sum, s) => sum + s.turns, 0),
      totalRotations: segments.reduce((sum, s) => sum + s.rotations, 0),
    },
    error: null,
    unknownLabels,
  };
}

export { Method };
