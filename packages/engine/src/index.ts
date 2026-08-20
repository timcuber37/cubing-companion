/**
 * @cubing-companion/engine — 3x3x3 cube state, moves, and notation.
 *
 * The dependency root of the project. Analysis, segmentation, and search all build on
 * this; nothing here knows about smart cubes, CFOP, or the UI.
 */

export {
  CubeState,
  CORNER_NAMES,
  EDGE_NAMES,
  CENTER_NAMES,
  Face,
  NUM_CORNERS,
  NUM_EDGES,
  NUM_CENTERS,
  STATE_BYTES,
  type CornerName,
  type EdgeName,
  type FaceName,
} from "./state.ts";

export {
  applyMoveInPlace,
  applyMoves,
  applyMovesInPlace,
  invertMove,
  invertMoves,
  makeMove,
  normalizeAmount,
  stateAfter,
  type Move,
} from "./moves.ts";

export {
  NotationError,
  parseMoves,
  serializeMove,
  serializeMoves,
  toAlg,
} from "./notation.ts";

export {
  FaceletError,
  faceletsEqual,
  fromFacelets,
  NUM_FACELETS,
  toFacelets,
} from "./facelets.ts";

export {
  colorOnFace,
  isCornerSolved,
  isEdgeSolved,
  isSolvedIgnoringOrientation,
  isStandardOrientation,
  ORIENTATION_COUNT,
  whereIsCorner,
  whereIsEdge,
} from "./predicates.ts";

export { randomScramble, randomScrambleString } from "./scramble.ts";

export { FAMILIES, type Family } from "./tables.ts";
