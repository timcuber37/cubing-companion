/**
 * The cube input interface.
 *
 * `PLAN.md` specifies the shape: `connect / onMove(move, timestamp) / queryState /
 * onDisconnect`. Everything downstream — segmentation, scoring, replay — consumes this and
 * nothing below it, which is what makes the smart cube an input adapter rather than a
 * dependency. A pasted reconstruction and a Bluetooth cube are the same thing here.
 */
import type { CubeState, Move } from "@cubing-companion/engine";

/** Where a move stream came from. Useful for labelling sessions; never for branching logic. */
export type SourceKind = "smart-cube" | "manual" | "replay";

/** A single move, with whatever timing information the source could supply. */
export interface MoveEvent {
  readonly move: Move;
  /**
   * Source-assigned sequence number, 0–255 and wrapping. A gap means BLE packets were
   * missed, which is how desync is detected. Sources without a real serial simply count.
   */
  readonly serial: number;
  /**
   * Timestamp from the cube's own clock, in milliseconds since the cube's epoch.
   *
   * This is the *preferred* per-move source. It survives BLE batching, because the cube
   * records when the turn happened rather than when the packet arrived. It is not wall
   * clock — see {@link MoveTimeline} for converting it.
   */
  readonly cubeTimestamp: number | null;
  /**
   * Host clock (`performance.now()` domain) when the packet arrived.
   *
   * **Null on batched moves.** When several turns arrive in one BLE packet, only the newest
   * carries a meaningful host timestamp; the others are reconstructed and have none.
   */
  readonly localTimestamp: number | null;
}

/** Emitted when the tracked state and the cube's actual state disagree. */
export interface DesyncEvent {
  /** What we believed the cube was showing. */
  readonly expected: string;
  /** What the cube reported. */
  readonly actual: string;
  /** How the disagreement was noticed. */
  readonly reason: "serial-gap" | "state-mismatch" | "initial-sync";
}

export type Unsubscribe = () => void;

/**
 * A source of cube moves.
 *
 * Implementations must be safe to subscribe to before any moves arrive, and must call
 * disconnect listeners exactly once.
 */
export interface CubeSource {
  readonly kind: SourceKind;
  /** Human-readable device or source name, when there is one. */
  readonly name: string | null;

  onMove(listener: (event: MoveEvent) => void): Unsubscribe;
  onDisconnect(listener: () => void): Unsubscribe;

  /**
   * Ask the source what the cube currently shows.
   *
   * For a smart cube this is a round trip to the device; for manual and replay sources it
   * is the locally tracked state. Used to seed tracking and to recover from desync.
   */
  queryState(): Promise<CubeState>;

  disconnect(): Promise<void>;
}

/** Minimal listener bookkeeping, shared by the source implementations. */
export class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    // Copied so a listener that unsubscribes during dispatch cannot disturb the iteration.
    for (const listener of [...this.listeners]) listener(value);
  }
}
