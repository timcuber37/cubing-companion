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
  faceletsOfFace,
  fromFacelets,
  isFaceUniform,
  NUM_FACELETS,
  toFacelets,
} from "./facelets.ts";

export {
  colorOnFace,
  isCornerSolved,
  isEdgeSolved,
  isSolvedIgnoringOrientation,
  isStandardOrientation,
  normalizeOrientation,
  ORIENTATION_COUNT,
  whereIsCorner,
  whereIsEdge,
} from "./predicates.ts";

export {
  generateScramble,
  RANDOM_MOVE_LENGTH,
  RANDOM_STATE_TIMEOUT_MS,
  randomMoveScramble,
  randomScramble,
  randomScrambleString,
  type GeneratedScramble,
  type ScrambleKind,
} from "./scramble.ts";

export { FAMILIES, type Family } from "./tables.ts";
