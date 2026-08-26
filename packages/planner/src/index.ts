/**
 * @cubing-companion/planner — turning search results into advice.
 *
 * `solver` says what solves a position; this says which of those you should do, and how to hold
 * the cube while you do it. The second half is the one that matters: the corpus says pros spend
 * their rotations in inspection choosing a frame, then execute almost without rotating.
 */

export { COLOURS, colourName, colourOf, type Colour } from "./colours.ts";

export { awkwardTurns, comfortScore, FACE_SHARE } from "./comfort.ts";

export {
  ORIENTATIONS,
  orientationsWithColourDown,
  renameMoves,
  renameSlot,
  type Orientation,
} from "./orientation.ts";

export {
  CROSS_FEATURES,
  crossFeatures,
  PAIR_FEATURES,
  pairFeatures,
  slotsAdjacent,
  type CrossFeature,
  type PairCandidateInput,
  type PairContext,
  type PairFeature,
} from "./features.ts";

export {
  crossDecision,
  pairDecisions,
  WAYS_CAP,
  type CrossDecision,
  type PairDecision,
  type PairOption,
} from "./decisions.ts";

export {
  attribute,
  confidenceWording,
  phrase,
  reasons,
  type Attribution,
  type Named,
} from "./explain.ts";

export {
  rankByMoveCount,
  rankNextPair,
  rerankCross,
  type RankedSlot,
  type ScoreFn,
} from "./rank.ts";

export {
  planColour,
  planColours,
  type ColourPlan,
  type Hold,
  type PlanKind,
  type PlanOptions,
  type PlannedSolution,
} from "./plan.ts";
