/**
 * The capture state machine: turning a live move stream into a recorded solve.
 *
 * The whole problem is knowing when a solve starts and when it stops, from nothing but turns
 * of a cube. Three things make that tractable here:
 *
 * **Inspection is invisible.** A smart cube senses only outer-face quarter turns — no
 * rotations, no wide moves. Turning the cube over to inspect it produces no events at all, so
 * there is no risk of inspection being mistaken for the first move. (Manual input *can* emit
 * rotations, and they are recorded, but they equally cannot be confused with a start because
 * the solve begins on the first move of any kind after `ready`.)
 *
 * **The cube tells us when it is scrambled.** Rather than trusting that the solver applied the
 * scramble, the recorder compares the tracked position against the target and only arms when
 * they match.
 *
 * **The cube tells us when it is finished.** A solve ends when the cube is solved, allowing for
 * whole-cube rotation, so a solve that ends in a different orientation still counts.
 */
import {
  applyMoves,
  CubeState,
  isSolvedIgnoringOrientation,
  parseMoves,
  serializeMoves,
  toFacelets,
  type Move,
} from "@cubing-companion/engine";
import { MoveTimeline, type TimedMove } from "@cubing-companion/cube-link";
import type {
  RecorderPhase,
  RecorderState,
  SolveRecord,
  SolveSource,
} from "./types.ts";

const ROTATIONS = new Set(["x", "y", "z"]);

/** Turns per second beyond which the timing cannot have come from a human hand. */
const MAX_HUMAN_TPS = 50;

export interface RecorderOptions {
  readonly sessionId: string;
  readonly source: SolveSource;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  readonly makeId?: () => string;
}

const defaultId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `solve-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * Records one solve at a time from a stream of moves.
 *
 * Driven by explicit calls rather than by subscribing to a source, so the caller owns the
 * wiring and the machine stays synchronous and testable. Feed it `handleMove` for each move and
 * `handleState` whenever the tracked position changes.
 */
export class SolveRecorder {
  private readonly options: Required<Pick<RecorderOptions, "sessionId" | "source">> &
    RecorderOptions;
  private readonly now: () => number;
  private readonly makeId: () => string;

  private phase: RecorderPhase = "idle";
  private scrambleText: string | null = null;
  private targetFacelets: string | null = null;
  private startFacelets: string | null = null;
  private scrambleMatched = false;
  private moves: TimedMove[] = [];
  private timeline = new MoveTimeline();
  private startedAt: number | null = null;
  private finished: SolveRecord | null = null;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? defaultId;
  }

  getState(): RecorderState {
    return {
      phase: this.phase,
      scrambleText: this.scrambleText,
      moveCount: this.moves.length - this.inspectionMoves(this.moves),
      elapsedMs: this.elapsedMs(),
      record: this.finished,
    };
  }

  /**
   * Display a scramble and wait for the cube to reach it.
   *
   * The current position is required, not optional: arming a cube that already matches must
   * land in `ready` immediately. Waiting for the next `handleState` would leave a correctly
   * scrambled cube stuck in `scrambling` until something moved, and the next thing to move it
   * would be the solver starting to solve.
   */
  arm(scrambleText: string, current: CubeState): void {
    this.reset();
    this.scrambleText = scrambleText;
    this.targetFacelets = toFacelets(
      applyMoves(CubeState.solved(), parseMoves(scrambleText)),
    );
    this.phase = "scrambling";
    this.handleState(current);
  }

  /**
   * Begin from wherever the cube is now, ignoring any displayed scramble.
   *
   * A solver who mis-scrambles should not be stuck waiting for a match that will never come.
   * Because a record stores the starting position rather than the intended scramble, a solve
   * begun this way is exactly as analysable as any other — only `scrambleMatched` differs.
   */
  startFrom(state: CubeState): void {
    this.moves = [];
    this.timeline = new MoveTimeline();
    this.finished = null;
    this.startFacelets = toFacelets(state);
    this.scrambleMatched = this.targetFacelets === this.startFacelets;
    this.startedAt = null;
    this.phase = "ready";
  }

  /**
   * Report the tracked position.
   *
   * Call whenever it changes. Before the solve starts this is what arms and disarms the
   * recorder; during a solve it is what ends it.
   */
  handleState(state: CubeState): void {
    const facelets = toFacelets(state);

    if (this.phase === "scrambling") {
      if (facelets === this.targetFacelets) {
        this.startFacelets = facelets;
        this.scrambleMatched = true;
        this.phase = "ready";
      }
      return;
    }

    // Note there is deliberately no transition back out of `ready`.
    //
    // It is tempting to add one: if the cube stops matching the scramble before the solve
    // begins, surely the solver is still scrambling? But the first move of a real solve also
    // leaves the target position, so from state alone "fiddling" and "started solving" are the
    // same observation. Guessing would either swallow the first move of real solves or start
    // the timer during scrambles. The first move after `ready` starts the solve, and `discard`
    // is the remedy for a false start — which is how timers behave anyway.

    if (this.phase === "solving" && isSolvedIgnoringOrientation(state)) {
      this.complete("solved");
    }
  }

  /**
   * Report a move.
   *
   * Must be called *before* {@link handleState} for the same move, so that the move which
   * solves the cube is recorded as part of the solve rather than after it.
   */
  handleMove(move: TimedMove): void {
    if (this.phase === "ready") {
      this.phase = "solving";
      this.startedAt = this.now();
    }
    if (this.phase !== "solving") return;
    this.moves.push(move);
    this.timeline.add(move);
  }

  /** Abandon the current solve, keeping a record of it as discarded. */
  discard(): SolveRecord | null {
    if (this.phase !== "solving" && this.phase !== "complete") return null;
    return this.complete("discarded");
  }

  /** Clear everything back to idle. */
  reset(): void {
    this.phase = "idle";
    this.scrambleText = null;
    this.targetFacelets = null;
    this.startFacelets = null;
    this.scrambleMatched = false;
    this.moves = [];
    this.timeline = new MoveTimeline();
    this.startedAt = null;
    this.finished = null;
  }

  /**
   * How many moves at the front are rotations, and so belong to inspection.
   *
   * A rotation solves nothing — it is the solver deciding how to hold the cube, which under WCA
   * rules happens during the 15 seconds of inspection, before the attempt has started. The corpus
   * says that is exactly what it is used for: pros rotate 1.45 times before their first turn and
   * only 0.23 times during the whole cross.
   *
   * They stay in the recorded solution, because *which* way you chose to hold it is precisely
   * what A4 recommends and B3 models. They are just not counted as moves, and the clock does not
   * start until the first real turn.
   */
  private inspectionMoves(moves: readonly TimedMove[]): number {
    const first = moves.findIndex((m) => !ROTATIONS.has(m.move.family));
    return first === -1 ? moves.length : first;
  }

  private elapsedMs(): number | null {
    if (this.finished) return this.finished.durationMs;
    if (this.phase !== "solving") return null;
    const timestamps = this.moves
      .slice(this.inspectionMoves(this.moves))
      .map((m) => m.timestamp)
      .filter((t): t is number => t !== null);
    if (timestamps.length < 2) return 0;
    return timestamps[timestamps.length - 1]! - timestamps[0]!;
  }

  private complete(outcome: "solved" | "discarded"): SolveRecord {
    // Retime over the whole stream now that it is finished. Live, the timeline cannot place
    // moves that arrived before the first host timestamp — a real limitation of a batched BLE
    // stream — but with the solve complete every move can be fitted.
    const retimed = MoveTimeline.retime(this.moves);
    const timestamps = retimed.map((m) => m.timestamp);

    // The clock starts on the first real turn, not on an inspection rotation. `timestamps` keeps
    // every move so it stays index-aligned with the solution; only the span measured over it
    // moves.
    const inspection = this.inspectionMoves(retimed);
    const known = timestamps.slice(inspection).filter((t): t is number => t !== null);
    const durationMs =
      known.length >= 2 ? known[known.length - 1]! - known[0]! : null;

    const moveList: Move[] = retimed.map((m) => m.move);
    const turns = moveList.filter((m) => !ROTATIONS.has(m.family)).length;

    // Reject timing that no hand produced.
    //
    // Moves applied programmatically — a pasted algorithm, a replayed recording — all land
    // within a millisecond or so of each other, yielding durations near zero and turn rates in
    // the thousands. Keeping those would put fictional times in the solve list and, worse,
    // feed them to A3 as though they were real. The world record turn rate is around 15 per
    // second, so anything past this ceiling did not come from a person.
    const plausible =
      durationMs !== null && durationMs > 0 && turns / (durationMs / 1000) <= MAX_HUMAN_TPS;
    const reportedDuration = plausible ? durationMs : null;

    const record: SolveRecord = {
      id: this.makeId(),
      sessionId: this.options.sessionId,
      startedAt: this.startedAt ?? this.now(),
      startFacelets: this.startFacelets ?? toFacelets(CubeState.solved()),
      scrambleText: this.scrambleText,
      scrambleMatched: this.scrambleMatched,
      solution: serializeMoves(moveList),
      moveCount: moveList.length - inspection,
      durationMs: reportedDuration,
      tps: reportedDuration === null ? null : turns / (reportedDuration / 1000),
      source: this.options.source,
      outcome,
      // Withheld together with the duration: if the overall timing is not real, the per-move
      // timing it was derived from is not either, and leaving it would let phase durations
      // report a confident 0.00s under a solve whose time reads "unknown".
      moveTimestamps: plausible ? timestamps : timestamps.map(() => null),
    };

    this.finished = record;
    this.phase = "complete";
    return record;
  }
}
