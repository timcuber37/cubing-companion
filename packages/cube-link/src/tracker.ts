/**
 * Tracking what the cube is showing, and noticing when we are wrong.
 *
 * A move stream over Bluetooth is lossy. Packets get dropped, the cube gets turned while
 * the page is backgrounded, or someone scrambles it by hand while disconnected. If we only
 * ever apply moves, our idea of the cube silently diverges from reality and every downstream
 * metric is quietly garbage.
 *
 * Two defences, from cheap to authoritative:
 *
 * 1. **Serial gaps.** Each move carries a sequence number that advances by one per state
 *    change and wraps at 256. A jump means moves were missed. Cheap, immediate, but only
 *    detects loss — not a cube that was turned while we were not listening.
 * 2. **Facelet comparison.** Ask the cube what it actually shows and compare against what we
 *    believe. Authoritative, but a Bluetooth round trip, so it is used on suspicion and on a
 *    slow timer rather than per move.
 *
 * Recovery is always the same: adopt the cube's state as truth and say so. This class is
 * deliberately pure logic over an injected {@link CubeSource}, so all of it is testable with
 * a fake and none of it needs hardware.
 */
import {
  applyMoveInPlace,
  CubeState,
  toFacelets,
} from "@cubing-companion/engine";
import {
  Listeners,
  type CubeSource,
  type DesyncEvent,
  type MoveEvent,
  type Unsubscribe,
} from "./source.ts";
import { MoveTimeline, type TimedMove } from "./timeline.ts";

export interface TrackerOptions {
  /**
   * How often to verify against the cube, in milliseconds. `0` disables periodic checks.
   *
   * A slow default: verification costs a Bluetooth round trip, and serial gaps already
   * catch the common failure. This is the backstop for silent divergence.
   */
  readonly verifyIntervalMs?: number;
  /** Injected for tests. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

const DEFAULT_VERIFY_INTERVAL_MS = 30_000;

/** Serials wrap at 256, so a raw subtraction is wrong once per 256 moves. */
export function serialGap(previous: number, next: number): number {
  return (next - previous + 256) % 256;
}

/**
 * Maintains a {@link CubeState} from a move stream, and keeps it honest.
 */
export class CubeTracker {
  private readonly source: CubeSource;
  private readonly timeline = new MoveTimeline();
  private readonly moveListeners = new Listeners<TimedMove>();
  private readonly desyncListeners = new Listeners<DesyncEvent>();
  private readonly stateListeners = new Listeners<CubeState>();
  private readonly unsubscribes: Unsubscribe[] = [];

  private state = CubeState.solved();
  private lastSerial: number | null = null;
  private verifying = false;
  private intervalHandle: unknown = null;
  private readonly options: Required<Pick<TrackerOptions, "verifyIntervalMs">> &
    TrackerOptions;

  constructor(source: CubeSource, options: TrackerOptions = {}) {
    this.source = source;
    this.options = {
      verifyIntervalMs: options.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS,
      ...options,
    };
  }

  /** The cube state as currently believed. Returns a copy; callers cannot corrupt tracking. */
  getState(): CubeState {
    return this.state.clone();
  }

  onMove(listener: (move: TimedMove) => void): Unsubscribe {
    return this.moveListeners.add(listener);
  }

  onDesync(listener: (event: DesyncEvent) => void): Unsubscribe {
    return this.desyncListeners.add(listener);
  }

  /** Fires whenever the tracked state is replaced wholesale, i.e. after a re-seed. */
  onReseed(listener: (state: CubeState) => void): Unsubscribe {
    return this.stateListeners.add(listener);
  }

  /** Current cube-to-host clock skew, in percent, or `null` before it can be measured. */
  skewPercent(): number | null {
    return this.timeline.skewPercent();
  }

  /**
   * Begin tracking: seed from the cube, then follow its moves.
   *
   * Seeding first is not optional — applying moves onto an assumed-solved cube when the
   * cube is actually scrambled produces a state that is wrong from the first move.
   */
  async start(): Promise<void> {
    const actual = await this.source.queryState();
    this.adopt(actual, {
      expected: toFacelets(this.state),
      actual: toFacelets(actual),
      reason: "initial-sync",
    });

    this.unsubscribes.push(this.source.onMove((event) => this.handleMove(event)));
    this.unsubscribes.push(this.source.onDisconnect(() => void this.stop()));

    const { verifyIntervalMs } = this.options;
    if (verifyIntervalMs > 0) {
      const schedule = this.options.setInterval ?? setInterval;
      this.intervalHandle = schedule(() => void this.verify(), verifyIntervalMs);
    }
  }

  /** Stop tracking. Safe to call more than once. */
  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    if (this.intervalHandle !== null) {
      const cancel = this.options.clearInterval ?? clearInterval;
      cancel(this.intervalHandle as never);
      this.intervalHandle = null;
    }
  }

  /**
   * Ask the cube what it shows and reconcile.
   *
   * @returns whether the tracked state was already correct.
   */
  async verify(): Promise<boolean> {
    // Overlapping verifications would race to adopt stale states.
    if (this.verifying) return true;
    this.verifying = true;
    try {
      const actual = await this.source.queryState();
      const expected = toFacelets(this.state);
      const actualFacelets = toFacelets(actual);
      if (expected === actualFacelets) return true;

      this.adopt(actual, {
        expected,
        actual: actualFacelets,
        reason: "state-mismatch",
      });
      return false;
    } finally {
      this.verifying = false;
    }
  }

  private adopt(state: CubeState, event: DesyncEvent): void {
    this.state = state.clone();
    // A re-seed invalidates the clock fit: the moves either side of it are not a
    // continuous stream, and a gap would drag the regression.
    this.timeline.reset();
    this.lastSerial = null;
    this.desyncListeners.emit(event);
    this.stateListeners.emit(this.getState());
  }

  private handleMove(event: MoveEvent): void {
    const previous = this.lastSerial;
    this.lastSerial = event.serial;

    applyMoveInPlace(this.state, event.move);
    this.moveListeners.emit(this.timeline.add(event));

    // A gap of one is the normal case. Anything larger means we missed state changes, so
    // the moves we applied cannot have produced the cube's actual state.
    if (previous !== null) {
      const gap = serialGap(previous, event.serial);
      if (gap !== 1) {
        this.desyncListeners.emit({
          expected: toFacelets(this.state),
          actual: `serial ${previous} -> ${event.serial}`,
          reason: "serial-gap",
        });
        void this.verify();
      }
    }
  }
}
