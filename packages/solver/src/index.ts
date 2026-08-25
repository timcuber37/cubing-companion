/**
 * @cubing-companion/solver — cross and xcross candidate enumerators.
 *
 * Answers what *could* have been done. Depends on the engine and on `analysis` for cross
 * geometry, and on nothing that knows where moves came from.
 */

export {
  allowed,
  AMOUNTS,
  FACE_FAMILIES,
  OPPOSITE_FAMILY,
  SEARCH_MOVES,
} from "./moves.ts";

export {
  crossDistance,
  crossIndexNormalised,
  crossIndexOf,
  crossTable,
  INDEX_SPACE,
  MAX_CROSS_DISTANCE,
  packCross,
  REACHABLE_CROSS_POSITIONS,
  stepCross,
  UNREACHABLE,
  unpackCross,
  type CrossTable,
} from "./crossTable.ts";

export { enumerateCross, optimalCrossLength, solveCross } from "./cross.ts";

export {
  enumerateAllXcrosses,
  enumerateXcross,
  MAX_XCROSS_DEPTH,
} from "./xcross.ts";

export {
  isSlotSolved,
  MAX_PAIR_DISTANCE,
  packPair,
  PAIR_INDEX_SPACE,
  pairDistance,
  pairIndexFrom,
  pairIndexOf,
  pairTable,
} from "./pairTable.ts";

export {
  enumerateF2LInsertion,
  enumerateNextPair,
  MAX_INSERTION_DEPTH,
  type InsertionOptions,
  type NextPairOption,
} from "./f2l.ts";

export { hasWideEquivalent, respellAsWide, type Respelling } from "./respell.ts";

export type {
  Candidate,
  SearchOptions,
  SearchResult,
  SearchStats,
} from "./types.ts";
