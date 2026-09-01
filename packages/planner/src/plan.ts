/**
 * Turning search results into advice.
 *
 * `solver` answers "what solves this", in a fixed frame, unranked — deliberately, because
 * deciding what is *better* is a different question with a different kind of answer. This is
 * where that decision is made: pick the frame to hold the cube in, rank what is left, and say it
 * in terms a person can act on.
 *
 * Ranking is **length first, comfort second**. Comfort can reorder solutions of equal length but
 * can never promote a longer one, so the planner cannot talk you into a worse cross because it
 * reads nicely.
 */
import {
  Face,
  serializeMoves,
  type CubeState,
  type Move,
} from "@cubing-companion/engine";
import { GEOMETRY as SLOT_GEOMETRY, slotName } from "@cubing-companion/analysis";
import { slotColours } from "./colours.ts";
import { enumerateAllXcrosses, enumerateCross } from "@cubing-companion/solver";
import { awkwardTurns, comfortScore } from "./comfort.ts";
import {
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
  rotationBetween,
  type Orientation,
} from "./orientation.ts";

export type PlanKind = "cross" | "xcross";

/** How to hold the cube, named by colour because that is how a person orients one. */
export interface Hold {
  readonly down: Face;
  readonly front: Face;
  /** The rotation from the standard frame, for anyone who prefers it written out. */
  readonly rotation: string;
}

export interface PlannedSolution {
  readonly kind: PlanKind;
  readonly crossFace: Face;
  /** For an xcross: which slot gets filled, named in the frame being recommended. */
  readonly slot?: string;
  /** The same slot by its side colours — "green-red" — which no frame can rename. */
  readonly slotLabel?: string;
  /**
   * The rotations that take the cube **from the position it is actually in** to `hold`.
   *
   * What makes the recommendation literally executable: do these, then `moves`, from wherever
   * the cube currently sits, and the cross is built. Not counted in `length` — rotations are
   * free in HTM and the corpus's own crosses are counted the same way.
   */
  readonly setup: readonly Move[];
  readonly setupText: string;
  /** The moves as they should be turned once the cube is held as `hold` says. */
  readonly moves: readonly Move[];
  /**
   * The same solution in the search's own frame, before any grip was chosen.
   *
   * Kept so a ranker can reconsider the grip: `hold` is whichever of the four the comfort model
   * liked, and B3's cross model picks a different one about a third of the time.
   */
  readonly searchMoves: readonly Move[];
  /** The slot name in that same unrotated frame, for the same reason. */
  readonly searchSlot?: string;
  readonly text: string;
  readonly length: number;
  readonly hold: Hold;
  /** 0–1; see `comfort.ts` for what it does and does not know. */
  readonly comfort: number;
  readonly awkward: { readonly back: number; readonly left: number };
  /** Set only once B3's cross model has re-ranked; absent means comfort decided the order. */
  readonly modelScore?: number;
}

export interface ColourPlan {
  readonly crossFace: Face;
  /** Ranked, best first. */
  readonly cross: readonly PlannedSolution[];
  /** Ranked across all four slots, best first. */
  readonly xcross: readonly PlannedSolution[];
  /** Optimal lengths, kept even when the ranked lists are trimmed. */
  readonly crossLength: number;
  readonly xcrossLength: number;
  readonly elapsedMs: number;
}

export interface PlanOptions {
  /** Ranked solutions to keep per category. */
  readonly keep?: number;
  /** Consider solutions this many moves above the optimum. */
  readonly maxExtra?: number;
  /** Ceiling on what the search returns, before ranking. */
  readonly maxSolutions?: number;
  /** Skip the xcross sweep, which is most of the cost. */
  readonly crossOnly?: boolean;
}

const DEFAULTS = { keep: 3, maxExtra: 0, maxSolutions: 200, crossOnly: false };

/**
 * Choose the frame, from the four that put this cross colour down.
 *
 * This is the step that matters most. Measured over 809 optimal crosses, picking the best of the
 * four takes mean back-face turns from 1.19 to 0.39, and makes a back-free optimal cross
 * available for 90% of scrambles rather than 52%.
 */
function bestFrame(
  moves: readonly Move[],
  crossFace: Face,
): { orientation: Orientation; moves: Move[]; comfort: number } {
  let best: { orientation: Orientation; moves: Move[]; comfort: number } | null = null;

  for (const orientation of orientationsWithColourDown(crossFace)) {
    const renamed = renameMoves(moves, orientation);
    const comfort = comfortScore(renamed);
    if (best === null || comfort > best.comfort) {
      best = { orientation, moves: renamed, comfort };
    }
  }

  if (best === null) throw new RangeError(`no frame puts colour ${crossFace} down`);
  return best;
}

function present(
  kind: PlanKind,
  crossFace: Face,
  moves: readonly Move[],
  slot: string | undefined,
  startCentres: ArrayLike<number>,
): PlannedSolution {
  const framed = bestFrame(moves, crossFace);
  const { orientation } = framed;
  // From where the cube actually is — not from the normalised frame, which is the search's
  // fiction and matches the real cube only by coincidence.
  const setup = rotationBetween(startCentres, orientation.colourAt);
  return {
    kind,
    crossFace,
    ...(slot === undefined
      ? {}
      : {
          slot: renameSlot(slot, orientation),
          searchSlot: slot,
          slotLabel: slotColours(
            SLOT_GEOMETRY[crossFace]!.slots.find((s) => slotName(s) === slot)!,
          ),
        }),
    setup,
    setupText: serializeMoves(setup),
    moves: framed.moves,
    searchMoves: [...moves],
    text: serializeMoves(framed.moves),
    length: framed.moves.length,
    hold: {
      down: orientation.colourAt[Face.D]!,
      front: orientation.colourAt[Face.F]!,
      rotation: orientation.text,
    },
    comfort: framed.comfort,
    awkward: awkwardTurns(framed.moves),
  };
}

/** Shorter always wins; comfort only breaks ties. */
const byLengthThenComfort = (a: PlannedSolution, b: PlannedSolution): number =>
  a.length - b.length || b.comfort - a.comfort;

/** Everything worth saying about one cross colour from this position. */
export function planColour(
  state: CubeState,
  crossFace: Face,
  options: PlanOptions = {},
): ColourPlan {
  const { keep, maxExtra, maxSolutions, crossOnly } = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const search = { maxExtra, maxSolutions };

  const crossResult = enumerateCross(state, crossFace, search);
  const cross = crossResult.candidates
    .map((candidate) => present("cross", crossFace, candidate.moves, undefined, state.centers))
    .sort(byLengthThenComfort);

  const xcross: PlannedSolution[] = [];
  if (!crossOnly) {
    const geometrySlots = enumerateAllXcrosses(state, crossFace, search);
    for (const result of geometrySlots) {
      for (const candidate of result.candidates) {
        // `Candidate.slot` is already the slot's name in the search frame.
        xcross.push(
          present("xcross", crossFace, candidate.moves, candidate.slot, state.centers),
        );
      }
    }
    xcross.sort(byLengthThenComfort);
  }

  return {
    crossFace,
    cross: cross.slice(0, keep),
    xcross: xcross.slice(0, keep),
    crossLength: crossResult.optimal,
    xcrossLength: xcross.length === 0 ? -1 : xcross[0]!.length,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Plan several colours, cheapest cross first.
 *
 * The ordering is the point of colour neutrality: seeing that yellow goes in five moves and
 * white takes eight is the decision the feature exists to support.
 */
export function planColours(
  state: CubeState,
  crossFaces: readonly Face[],
  options: PlanOptions = {},
): ColourPlan[] {
  return crossFaces
    .map((face) => planColour(state, face, options))
    .sort((a, b) => a.crossLength - b.crossLength);
}

export { slotName };
