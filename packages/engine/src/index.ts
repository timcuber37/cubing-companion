/**
 * @cubing-companion/engine — 3x3x3 cube state, moves, and notation.
 *
 * The dependency root of the project. Analysis, segmentation, and search all build on
 * this; nothing here knows about smart cubes, CFOP, or the UI.
 *
 * **Scramble generation is deliberately not re-exported here** — import it from
 * `@cubing-companion/engine/scramble` instead. `scramble.ts` statically imports `cubing/scramble`
 * and `cubing/search`, which pull in a Web Worker and a base64-embedded WASM module. Re-exporting
 * it put that whole graph into every consumer of this barrel, including the ones that only wanted
 * `applyMoves`. Bundlers on the web tree-shake it away; runtimes without `Worker` or
 * `WebAssembly` cannot. Two files want a scramble, and they can ask for one by name.
 *
 * `packages/engine/test/boundaries.test.ts` enforces this.
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

export { FAMILIES, type Family } from "./tables.ts";
