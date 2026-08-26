/**
 * @cubing-companion/session — solve capture and local-first storage.
 *
 * The capture layer, so depending on `cube-link` is its job. The rule `PLAN.md` sets is that
 * *analysis* never depends on the input adapters, and it does not.
 */

export { SolveRecorder, type RecorderOptions } from "./recorder.ts";

export { MemoryStore, type SolveStore } from "./store.ts";

export { IndexedDbStore, isIndexedDbAvailable } from "./indexeddb.ts";

export { segmentRecord, type SegmentedSolve } from "./segmented.ts";
export { observesRotations, worthPlanning } from "./types.ts";

export type {
  RecorderPhase,
  RecorderState,
  SessionRecord,
  SolveOutcome,
  SolveRecord,
  SolveSource,
} from "./types.ts";
