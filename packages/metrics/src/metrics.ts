/**
 * Per-phase metrics for one solve.
 *
 * Pure: it takes spans and timestamps, not a stored record, so it depends on `analysis` and
 * `engine` and nothing that knows about storage. The web app composes `segmentRecord(record)`
 * and passes the pieces in.
 */
import type { Phase, PhaseSpan } from "@cubing-companion/analysis";
import {
  DEFAULT_PAUSE_OPTIONS,
  detectPauses,
  medianGapMs,
  pauseThresholdMs,
  type Pause,
  type PauseOptions,
} from "./pauses.ts";

export interface PhaseMetrics {
  readonly phase: Phase;
  readonly start: number;
  readonly end: number;
  readonly turns: number;
  readonly rotations: number;
  readonly slot?: string;

  readonly durationMs: number | null;
  /** Turns per second over the phase, rotations excluded. */
  readonly tps: number | null;
  /**
   * The gap before the phase's first move — looking for the piece rather than turning.
   *
   * Zero for the first phase of the solve, which has no interval before it to measure.
   */
  readonly recognitionMs: number | null;
  /** The rest of the phase. `recognitionMs + executionMs === durationMs`, exactly. */
  readonly executionMs: number | null;
  /** Share of the phase spent recognising rather than turning, 0..1. */
  readonly recognitionShare: number | null;

  readonly pauses: readonly Pause[];
  readonly pausedMs: number;
}

export interface SolveMetrics {
  readonly phases: readonly PhaseMetrics[];
  /** First move to last move. Not a stackmat time; see `session/src/types.ts`. */
  readonly durationMs: number | null;
  readonly turns: number;
  readonly rotations: number;
  readonly tps: number | null;

  readonly pauses: readonly Pause[];
  readonly longestPause: Pause | null;
  readonly pausedMs: number;
  /**
   * Share of the solve not spent inside a pause, 0..1.
   *
   * A blunt instrument by design: it says how much of the time went into turning, which is the
   * question a solver actually asks when a 9-second solve has 55 moves in it.
   */
  readonly fluidity: number | null;
  /** The tempo the pause threshold was derived from, for showing the user what was used. */
  readonly medianGapMs: number | null;
  readonly pauseThresholdMs: number;
}

/**
 * Duration of each span, aligned with `spans`.
 *
 * A phase runs from the move *before* it to its own last move: the elapsed time of a phase is
 * the gap between the previous move landing and this phase's final move landing, so the time
 * spent finding the next piece is charged to the phase that needed it.
 *
 * The first phase has no previous move and so falls back to its own first, covering one interval
 * fewer than a later phase of the same length. That is deliberate rather than an off-by-one: the
 * clock starts when the first move lands, the time before it belongs to nobody, and it is what
 * makes the phase durations sum to the solve duration exactly.
 */
export function phaseDurationsMs(
  spans: readonly PhaseSpan[],
  timestamps: readonly (number | null)[],
): readonly (number | null)[] {
  return spans.map((span) => window(span, timestamps).durationMs);
}

function window(
  span: PhaseSpan,
  timestamps: readonly (number | null)[],
): { durationMs: number | null; recognitionMs: number | null; executionMs: number | null } {
  // A skipped phase — an OLL skip — took no time, which is different from unknown.
  if (span.end === span.start) {
    return { durationMs: 0, recognitionMs: 0, executionMs: 0 };
  }
  const first = timestamps[span.start] ?? null;
  const last = timestamps[span.end - 1] ?? null;
  if (first === null || last === null) {
    return { durationMs: null, recognitionMs: null, executionMs: null };
  }
  const previous = span.start > 0 ? (timestamps[span.start - 1] ?? null) : null;
  const from = previous ?? first;
  return {
    durationMs: last - from,
    recognitionMs: first - from,
    executionMs: last - first,
  };
}

const ratePerSecond = (count: number, ms: number | null): number | null =>
  ms === null || ms <= 0 ? null : (count * 1000) / ms;

export function computeMetrics(
  spans: readonly PhaseSpan[],
  timestamps: readonly (number | null)[],
  options: PauseOptions = DEFAULT_PAUSE_OPTIONS,
): SolveMetrics {
  const pauses = detectPauses(timestamps, options);

  const phases = spans.map((span): PhaseMetrics => {
    const { durationMs, recognitionMs, executionMs } = window(span, timestamps);
    // A pause is charged to the phase of the move it precedes, matching `recognitionMs`: the
    // stall before a pair's first move is that pair's problem, not the previous pair's.
    const inPhase = pauses.filter((p) => p.moveIndex >= span.start && p.moveIndex < span.end);
    return {
      phase: span.phase,
      start: span.start,
      end: span.end,
      turns: span.turns,
      rotations: span.rotations,
      ...(span.slot === undefined ? {} : { slot: span.slot }),
      durationMs,
      tps: ratePerSecond(span.turns, durationMs),
      recognitionMs,
      executionMs,
      recognitionShare:
        recognitionMs === null || durationMs === null || durationMs <= 0
          ? null
          : recognitionMs / durationMs,
      pauses: inPhase,
      pausedMs: inPhase.reduce((total, p) => total + p.durationMs, 0),
    };
  });

  const usable = timestamps.filter((t): t is number => t !== null);
  const durationMs =
    usable.length >= 2 ? usable[usable.length - 1]! - usable[0]! : null;

  const turns = spans.reduce((total, span) => total + span.turns, 0);
  const rotations = spans.reduce((total, span) => total + span.rotations, 0);
  const pausedMs = pauses.reduce((total, p) => total + p.durationMs, 0);

  return {
    phases,
    durationMs,
    turns,
    rotations,
    tps: ratePerSecond(turns, durationMs),
    pauses,
    longestPause:
      pauses.length === 0
        ? null
        : pauses.reduce((worst, p) => (p.durationMs > worst.durationMs ? p : worst)),
    pausedMs,
    fluidity:
      durationMs === null || durationMs <= 0
        ? null
        : Math.max(0, 1 - pausedMs / durationMs),
    medianGapMs: medianGapMs(timestamps),
    pauseThresholdMs: pauseThresholdMs(timestamps, options),
  };
}
