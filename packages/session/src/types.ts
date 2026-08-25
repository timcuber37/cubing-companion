/**
 * Session and solve records.
 *
 * Everything persisted is plain JSON: moves are notation strings, states are facelet strings.
 * Nothing here stores a `CubeState` or a `Move[]` directly, because those are typed arrays and
 * objects whose in-memory shape is an implementation detail — a stored record should still be
 * readable after the engine's internals change, and should survive the trip to a server when
 * sync arrives.
 */

/** Where a solve's moves came from. Recorded so timings are never compared across kinds. */
export type SolveSource = "smart-cube" | "manual" | "replay";

/** How a solve ended. */
export type SolveOutcome = "solved" | "discarded";

/**
 * One recorded solve.
 *
 * The important field is `startFacelets`, not `scrambleText`. See `recorder.ts` for why: the
 * cube's actual starting position is the only thing guaranteed to describe the solve, while
 * the scramble somebody meant to apply frequently does not.
 */
export interface SolveRecord {
  readonly id: string;
  readonly sessionId: string;
  /** Wall-clock time the solve began, for ordering and display. */
  readonly startedAt: number;

  /** The position the solve started from. Authoritative. */
  readonly startFacelets: string;
  /** The scramble that was displayed, for reference only — the cube may not have matched it. */
  readonly scrambleText: string | null;
  /** True when the cube reached `startFacelets` by following `scrambleText` exactly. */
  readonly scrambleMatched: boolean;

  /** The solve, in notation. */
  readonly solution: string;
  readonly moveCount: number;

  /**
   * Milliseconds from the first move to the last.
   *
   * **Not a stackmat time.** It excludes inspection and the hand movement a timer would
   * capture, which is exactly why reco.nz removed its smartcube reconstructions: the two are
   * not comparable. A3 must not score this against corpus percentiles without saying so.
   */
  readonly durationMs: number | null;
  /** Turns per second over `durationMs`, excluding rotations. */
  readonly tps: number | null;

  readonly source: SolveSource;
  readonly outcome: SolveOutcome;

  /** Per-move timestamps in the host clock, aligned by `MoveTimeline.retime`. */
  readonly moveTimestamps: readonly (number | null)[];
}

/** A group of solves, as a timer session. */
export interface SessionRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly label: string;
}

/**
 * Where the recorder is in the scramble-then-solve cycle.
 *
 * - `idle` — nothing armed.
 * - `scrambling` — a scramble is displayed; the cube has not reached it.
 * - `ready` — the cube matches the scramble; the next turn starts the solve.
 * - `solving` — recording.
 * - `complete` — the cube is solved and the record is ready to be saved.
 */
export type RecorderPhase =
  | "idle"
  | "scrambling"
  | "ready"
  | "solving"
  | "complete";

export interface RecorderState {
  readonly phase: RecorderPhase;
  /** The scramble on display, if any. */
  readonly scrambleText: string | null;
  /** Moves recorded so far. */
  readonly moveCount: number;
  /** Elapsed milliseconds, live while solving and final once complete. */
  readonly elapsedMs: number | null;
  /** The finished record, present only in `complete`. */
  readonly record: SolveRecord | null;
}
