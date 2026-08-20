/**
 * Turning cube time into host time.
 *
 * `PLAN.md`: "smooth/bucket BLE move timestamps before any TPS/pause metric; expect
 * batching jitter." Here is the concrete problem it was anticipating.
 *
 * A GAN cube reports two clocks per move. The host clock records when the *packet* arrived,
 * which is useless for timing: several turns arrive together and only the newest gets a
 * host timestamp at all — the rest are reconstructed and carry `null`. The cube's own clock
 * records when each *turn* happened, which is what we want, but it runs at its own rate and
 * from its own epoch, and it drifts measurably against the host.
 *
 * So: take cube time as the per-move truth, and least-squares fit it onto host time using
 * the moves that carry both. Fitting rather than offsetting matters — the cube's clock rate
 * is not exactly the host's, so a single subtracted offset accumulates error across a solve.
 *
 * The fit is implemented here rather than imported from `gan-web-bluetooth` deliberately:
 * this module must stay free of any transport, so it can be tested against synthetic
 * streams and reused for any future cube.
 */
import type { MoveEvent } from "./source.ts";

/** A move with a timestamp in the host clock domain, once one could be established. */
export interface TimedMove extends MoveEvent {
  /**
   * Best estimate of when this turn happened, in the host clock domain, or `null` when the
   * source gave us nothing to work with.
   */
  readonly timestamp: number | null;
  /** How `timestamp` was arrived at, so the UI can be honest about precision. */
  readonly timestampSource: "fitted" | "cube-offset" | "local" | "none";
}

export interface TimelineOptions {
  /**
   * How many anchor points (moves carrying both clocks) to fit over.
   *
   * Bounded because clock drift is not perfectly linear over long sessions; a rolling
   * window tracks slow drift instead of averaging it away.
   */
  readonly windowSize?: number;
}

const DEFAULT_WINDOW = 64;

interface Anchor {
  readonly cube: number;
  readonly local: number;
}

/** Least-squares fit of `local = slope * cube + intercept`. */
function fit(anchors: readonly Anchor[]): { slope: number; intercept: number } | null {
  if (anchors.length < 2) return null;

  let sumCube = 0;
  let sumLocal = 0;
  for (const a of anchors) {
    sumCube += a.cube;
    sumLocal += a.local;
  }
  const meanCube = sumCube / anchors.length;
  const meanLocal = sumLocal / anchors.length;

  let covariance = 0;
  let variance = 0;
  for (const a of anchors) {
    const d = a.cube - meanCube;
    covariance += d * (a.local - meanLocal);
    variance += d * d;
  }
  // All anchors share a cube timestamp: no rate information, so no fit.
  if (variance === 0) return null;

  const slope = covariance / variance;
  return { slope, intercept: meanLocal - slope * meanCube };
}

/**
 * Converts a stream of {@link MoveEvent}s into host-clock timestamps.
 *
 * Stateful and order-dependent: feed it moves as they arrive.
 */
export class MoveTimeline {
  private readonly anchors: Anchor[] = [];
  private readonly windowSize: number;
  private current: { slope: number; intercept: number } | null = null;

  constructor(options: TimelineOptions = {}) {
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW;
  }

  /**
   * Record a move and return it with a host-clock timestamp.
   *
   * Resolution order:
   * 1. cube time through the fit — survives batching, correct rate;
   * 2. cube time offset by the most recent anchor, before enough points to fit;
   * 3. the host timestamp, if the move has one;
   * 4. nothing.
   */
  add(event: MoveEvent): TimedMove {
    if (event.cubeTimestamp !== null && event.localTimestamp !== null) {
      this.anchors.push({ cube: event.cubeTimestamp, local: event.localTimestamp });
      if (this.anchors.length > this.windowSize) this.anchors.shift();
      this.current = fit(this.anchors);
    }

    if (event.cubeTimestamp !== null && this.current !== null) {
      return {
        ...event,
        timestamp: this.current.slope * event.cubeTimestamp + this.current.intercept,
        timestampSource: "fitted",
      };
    }

    if (event.cubeTimestamp !== null && this.anchors.length > 0) {
      const anchor = this.anchors[this.anchors.length - 1]!;
      return {
        ...event,
        timestamp: anchor.local + (event.cubeTimestamp - anchor.cube),
        timestampSource: "cube-offset",
      };
    }

    if (event.localTimestamp !== null) {
      return { ...event, timestamp: event.localTimestamp, timestampSource: "local" };
    }

    return { ...event, timestamp: null, timestampSource: "none" };
  }

  /**
   * How fast the cube's clock runs relative to the host's, as a percentage.
   *
   * Positive means the cube ticks faster than real time. `0` means the rates agree. A few
   * percent is normal, and is exactly why a single subtracted offset is insufficient.
   * `null` until there are enough anchors to tell.
   *
   * The fit is `local = slope * cube`, so the cube's rate is the reciprocal of the slope.
   */
  skewPercent(): number | null {
    if (this.current === null || this.current.slope === 0) return null;
    return (1 / this.current.slope - 1) * 100;
  }

  /** How many moves have contributed to the fit. */
  get anchorCount(): number {
    return this.anchors.length;
  }

  /**
   * Resolve a complete stream in one pass.
   *
   * {@link add} can only use anchors it has already seen, so the moves before the first
   * host timestamp — typically the opening batch of a session — stay unresolved. That is
   * the honest answer live, but it is the wrong answer for analysis: once a solve is
   * finished the whole stream is available, and every move can be placed using a fit over
   * all of it.
   *
   * This is what A3's TPS and pause metrics should consume. It does not disturb the live
   * timeline's state.
   */
  static retime(events: readonly MoveEvent[]): TimedMove[] {
    const anchors: Anchor[] = [];
    for (const event of events) {
      if (event.cubeTimestamp !== null && event.localTimestamp !== null) {
        anchors.push({ cube: event.cubeTimestamp, local: event.localTimestamp });
      }
    }
    const fitted = fit(anchors);

    return events.map((event) => {
      if (event.cubeTimestamp !== null && fitted !== null) {
        return {
          ...event,
          timestamp: fitted.slope * event.cubeTimestamp + fitted.intercept,
          timestampSource: "fitted" as const,
        };
      }
      if (event.cubeTimestamp !== null && anchors.length === 1) {
        const anchor = anchors[0]!;
        return {
          ...event,
          timestamp: anchor.local + (event.cubeTimestamp - anchor.cube),
          timestampSource: "cube-offset" as const,
        };
      }
      if (event.localTimestamp !== null) {
        return {
          ...event,
          timestamp: event.localTimestamp,
          timestampSource: "local" as const,
        };
      }
      return { ...event, timestamp: null, timestampSource: "none" as const };
    });
  }

  reset(): void {
    this.anchors.length = 0;
    this.current = null;
  }
}
