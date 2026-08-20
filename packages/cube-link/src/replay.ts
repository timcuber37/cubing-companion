/**
 * Replay: a recorded move stream played back as a live source.
 *
 * Two jobs. It lets the UI be built and demonstrated without a cube in hand, and it lets
 * tests reproduce the awkward parts of a real Bluetooth stream exactly — batched packets
 * with null host timestamps, dropped serials, clock skew — which are precisely the
 * conditions that are impossible to trigger on demand with real hardware.
 */
import {
  applyMoveInPlace,
  CubeState,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { Listeners, type CubeSource, type MoveEvent } from "./source.ts";

/** One recorded move. Timestamps are relative to the start of the recording. */
export interface RecordedMove {
  readonly move: Move;
  readonly cubeTimestamp: number | null;
  readonly localTimestamp: number | null;
}

export interface ReplaySourceOptions {
  /** Where the cube started. Defaults to solved. */
  readonly initialState?: CubeState;
  /**
   * Serial number to start from, and whether to advance it truthfully.
   *
   * Set `dropSerials` to skip numbers, simulating missed BLE packets so desync handling can
   * be exercised.
   */
  readonly startSerial?: number;
  readonly dropSerials?: number;
}

/**
 * Build a recording from notation, with a fixed interval between moves.
 *
 * `batchSize` reproduces the behaviour that makes GAN timing awkward: within each batch,
 * only the final move carries a host timestamp, because the others were recovered from a
 * single packet rather than observed on arrival.
 *
 * `cubeClockRate` scales the cube's clock against the host's — `1.02` means the cube runs
 * 2% fast, which is the kind of skew a real cube shows and the reason a plain offset is not
 * good enough.
 */
export function recordingFromAlg(
  alg: string,
  options: {
    intervalMs?: number;
    batchSize?: number;
    cubeClockRate?: number;
    cubeEpoch?: number;
    localEpoch?: number;
  } = {},
): RecordedMove[] {
  const {
    intervalMs = 200,
    batchSize = 1,
    cubeClockRate = 1,
    cubeEpoch = 0,
    localEpoch = 1_000,
  } = options;

  const moves = parseMoves(alg);
  return moves.map((move, index) => {
    const elapsed = index * intervalMs;
    const isLastOfBatch = (index + 1) % batchSize === 0 || index === moves.length - 1;
    return {
      move,
      cubeTimestamp: cubeEpoch + elapsed * cubeClockRate,
      localTimestamp: isLastOfBatch ? localEpoch + elapsed : null,
    };
  });
}

/**
 * Plays a recording back through the {@link CubeSource} interface.
 *
 * Playback is driven by explicit calls rather than timers, so tests stay deterministic. The
 * UI advances it on an interval of its own choosing.
 */
export class ReplaySource implements CubeSource {
  readonly kind = "replay" as const;
  readonly name = "Replay";

  private readonly moveListeners = new Listeners<MoveEvent>();
  private readonly disconnectListeners = new Listeners<void>();
  private readonly recording: readonly RecordedMove[];
  private readonly dropSerials: number;
  private state: CubeState;
  private serial: number;
  private index = 0;
  private connected = true;

  constructor(recording: readonly RecordedMove[], options: ReplaySourceOptions = {}) {
    this.recording = recording;
    this.state = (options.initialState ?? CubeState.solved()).clone();
    this.serial = options.startSerial ?? 0;
    this.dropSerials = options.dropSerials ?? 0;
  }

  onMove(listener: (event: MoveEvent) => void) {
    return this.moveListeners.add(listener);
  }

  onDisconnect(listener: () => void) {
    return this.disconnectListeners.add(listener);
  }

  async queryState(): Promise<CubeState> {
    return this.state.clone();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectListeners.emit();
  }

  /** Whether any moves remain. */
  get hasMore(): boolean {
    return this.index < this.recording.length;
  }

  get remaining(): number {
    return this.recording.length - this.index;
  }

  /**
   * Emit the next move.
   *
   * @returns whether a move was emitted.
   */
  step(): boolean {
    const recorded = this.recording[this.index];
    if (recorded === undefined) return false;
    this.index++;

    applyMoveInPlace(this.state, recorded.move);
    this.serial = (this.serial + 1 + this.dropSerials) % 256;
    this.moveListeners.emit({
      move: recorded.move,
      serial: this.serial,
      cubeTimestamp: recorded.cubeTimestamp,
      localTimestamp: recorded.localTimestamp,
    });
    return true;
  }

  /** Emit every remaining move at once. */
  stepAll(): number {
    let count = 0;
    while (this.step()) count++;
    return count;
  }

  /**
   * Advance the underlying cube *without* emitting moves.
   *
   * Simulates the cube being turned while nothing was listening — a page in the background,
   * or a hand scramble between sessions. The tracked state has no way to know, which is
   * exactly what facelet verification exists to catch.
   */
  applySilently(alg: string): void {
    for (const move of parseMoves(alg)) {
      applyMoveInPlace(this.state, move);
    }
  }
}
