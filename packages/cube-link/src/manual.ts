/**
 * Manual input: typed keys and pasted algorithms.
 *
 * `PLAN.md` makes this a first-class input, not a fallback — "the analysis engine is
 * input-agnostic", and manual input is what keeps every other track unblocked when the
 * Bluetooth protocol misbehaves. It implements exactly the same {@link CubeSource} as the
 * smart cube, so nothing downstream can tell them apart.
 */
import {
  applyMoveInPlace,
  CubeState,
  parseMoves,
  type Move,
} from "@cubing-companion/engine";
import { Listeners, type CubeSource, type MoveEvent } from "./source.ts";

/**
 * Keyboard layout, following the convention used by cubing.js and most online timers:
 * home-row-ish keys for the common faces, shift-free, with the opposite case giving the
 * inverse.
 */
export const DEFAULT_KEY_MAP: Readonly<Record<string, string>> = {
  j: "U", f: "U'",
  h: "F", g: "F'",
  i: "R", k: "R'",
  d: "L", e: "L'",
  s: "D", l: "D'",
  w: "B", o: "B'",
  ";": "y", a: "y'",
  p: "z", q: "z'",
  n: "x", y: "x", b: "x'", v: "Lw",
  ".": "M'", x: "M",
  u: "r", m: "r'",
  r: "l'", t: "l",
};

export interface ManualSourceOptions {
  /** Override the key bindings. Values are notation strings such as `R` or `U'`. */
  readonly keyMap?: Readonly<Record<string, string>>;
  /** Injected for tests; defaults to `performance.now()` where available. */
  readonly now?: () => number;
}

const defaultNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * A cube driven by the keyboard or by pasted algorithms.
 *
 * Timestamps are host-clock only: there is no second clock to reconcile, so every move
 * carries `cubeTimestamp: null` and a real `localTimestamp`. Downstream code handles that
 * without special-casing, which is a useful check that the timing layer is not quietly
 * assuming a smart cube.
 */
export class ManualSource implements CubeSource {
  readonly kind = "manual" as const;
  readonly name = "Manual input";

  private readonly moveListeners = new Listeners<MoveEvent>();
  private readonly disconnectListeners = new Listeners<void>();
  private readonly keyMap: Readonly<Record<string, string>>;
  private readonly now: () => number;
  private state = CubeState.solved();
  private serial = 0;
  private connected = true;

  constructor(options: ManualSourceOptions = {}) {
    this.keyMap = options.keyMap ?? DEFAULT_KEY_MAP;
    this.now = options.now ?? defaultNow;
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

  /** The notation a key produces, or `undefined` if it is not bound. */
  moveForKey(key: string): string | undefined {
    return this.keyMap[key];
  }

  /**
   * Handle a key press.
   *
   * @returns whether the key was bound. Unbound keys are ignored rather than throwing —
   * this sits directly under a keydown handler, where most keys are not cube moves.
   */
  pressKey(key: string): boolean {
    const notation = this.keyMap[key];
    if (notation === undefined) return false;
    this.applyAll(parseMoves(notation));
    return true;
  }

  /**
   * Apply an algorithm, as typed or pasted.
   *
   * Accepts everything the engine's notation layer does, including `//` comments and
   * newlines — so a reconstruction can be pasted in whole.
   *
   * @throws {NotationError} on unparseable input; callers should surface it to the user
   * rather than swallowing it.
   */
  applyAlg(text: string): Move[] {
    const moves = parseMoves(text);
    this.applyAll(moves);
    return moves;
  }

  /** Reset to a solved cube, as if a fresh cube had been picked up. */
  reset(): void {
    this.state = CubeState.solved();
  }

  private applyAll(moves: readonly Move[]): void {
    for (const move of moves) {
      applyMoveInPlace(this.state, move);
      this.serial = (this.serial + 1) % 256;
      this.moveListeners.emit({
        move,
        serial: this.serial,
        cubeTimestamp: null,
        localTimestamp: this.now(),
      });
    }
  }
}
