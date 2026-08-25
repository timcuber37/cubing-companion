/**
 * @cubing-companion/analysis — CFOP phase segmentation.
 *
 * Depends on the engine and nothing else. It must never import `cube-link`: the analysis
 * layer works on moves and states, and cannot be allowed to care where they came from.
 */

export {
  ALL_FACES,
  CORNER_FACES,
  EDGE_FACES,
  faceName,
  GEOMETRY,
  OPPOSITE,
  slotName,
  type CrossGeometry,
  type Slot,
} from "./geometry.ts";

export {
  alignCross,
  crossOffset,
  isCrossBuilt,
  isF2LComplete,
  isLastLayerOriented,
  isSlotSolved,
  isSolvedIgnoringAUF,
} from "./phases.ts";

export {
  segmentFromState,
  segmentSolve,
  type SegmentOptions,
} from "./segment.ts";

export {
  Phase,
  PHASE_ORDER,
  type PhaseSpan,
  type SegmentationFailure,
  type SegmentationResult,
  type SolveSegmentation,
} from "./types.ts";
