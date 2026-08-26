/**
 * @cubing-companion/metrics — per-phase solve metrics and percentile scoring.
 *
 * A2 says what a solve *was*; B2 says what could have been done instead. This says whether it
 * was any good, by placing each phase against B1's corpus of world-class solves.
 *
 * Pure: it takes spans and timestamps rather than a stored record, so it depends on `engine` and
 * `analysis` and nothing that knows about storage or the network.
 */

export {
  computeMetrics,
  phaseDurationsMs,
  solveStartIndex,
  type PhaseMetrics,
  type SolveMetrics,
} from "./metrics.ts";

export {
  DEFAULT_PAUSE_OPTIONS,
  detectPauses,
  medianGapMs,
  moveGaps,
  pauseThresholdMs,
  type Pause,
  type PauseOptions,
} from "./pauses.ts";

export {
  asRating,
  corpusRank,
  FLUIDITY_BANDS,
  fluidityBand,
  rateRotations,
  rateTime,
  rateTurns,
  scoreSolve,
  scoreWindows,
  type PhaseScore,
  type Rated,
  type SolveScore,
  type WindowScore,
} from "./score.ts";

export { TimeWindow } from "./baselines.ts";
export type {
  Baselines,
  Distribution,
  TimeBaseline,
  TimerOverhead,
  TurnBaseline,
} from "./baselines.ts";

export { BASELINES } from "./baselines.generated.ts";
