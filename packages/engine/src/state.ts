/**
 * 3x3x3 cube state.
 *
 * Piece indexing is cubing.js's KPuzzle convention (see `scripts/generate-tables.ts` for
 * why). Names below were derived from which face turns move which pieces, so they are
 * facts about the tables rather than assumptions layered on top of them.
 */

export const NUM_CORNERS = 8;
export const NUM_EDGES = 12;
export const NUM_CENTERS = 6;

/**
 * Corner slot names. The first letter is the U/D facelet — that is the facelet whose
 * position defines the corner's orientation value.
 */
export const CORNER_NAMES = [
  "URF", "UBR", "ULB", "UFL", "DFR", "DLF", "DBL", "DRB",
] as const;

/** Edge slot names. */
export const EDGE_NAMES = [
  "UF", "UR", "UB", "UL", "DF", "DR", "DB", "DL", "FR", "FL", "BR", "BL",
] as const;

/** Center slot names, indexed by {@link Face}. */
export const CENTER_NAMES = ["U", "L", "F", "R", "B", "D"] as const;

export type CornerName = (typeof CORNER_NAMES)[number];
export type EdgeName = (typeof EDGE_NAMES)[number];
export type FaceName = (typeof CENTER_NAMES)[number];

/** Center slot indices. A center slot is a fixed position in space, not a colour. */
export const Face = { U: 0, L: 1, F: 2, R: 3, B: 4, D: 5 } as const;
export type Face = (typeof Face)[keyof typeof Face];

// Byte offsets into the backing buffer.
const OFF_CP = 0;
const OFF_CO = OFF_CP + NUM_CORNERS; // 8
const OFF_EP = OFF_CO + NUM_CORNERS; // 16
const OFF_EO = OFF_EP + NUM_EDGES; // 28
const OFF_CENTERS = OFF_EO + NUM_EDGES; // 40
export const STATE_BYTES = OFF_CENTERS + NUM_CENTERS; // 46

/**
 * A cube state as flat typed arrays over one 46-byte buffer.
 *
 * The five arrays are views into `bytes`, so cloning and comparison are single-buffer
 * operations, and the whole state fits in a cache line pair — which is what the IDA*
 * search in B2 will want.
 *
 * Semantics match KPuzzle: `cp[i]` is the *piece* currently sitting in *slot* `i`.
 */
export class CubeState {
  /** The whole state as one byte array. Layout: cp | co | ep | eo | centers. */
  readonly bytes: Uint8Array;
  /** Corner permutation: `cp[slot]` = corner piece in that slot. */
  readonly cp: Uint8Array;
  /** Corner orientation, mod 3. */
  readonly co: Uint8Array;
  /** Edge permutation: `ep[slot]` = edge piece in that slot. */
  readonly ep: Uint8Array;
  /** Edge orientation, mod 2. */
  readonly eo: Uint8Array;
  /** Center permutation: `centers[slot]` = center piece in that slot. */
  readonly centers: Uint8Array;

  constructor(bytes: Uint8Array = new Uint8Array(STATE_BYTES)) {
    if (bytes.length !== STATE_BYTES) {
      throw new RangeError(`expected ${STATE_BYTES} bytes, got ${bytes.length}`);
    }
    this.bytes = bytes;
    this.cp = bytes.subarray(OFF_CP, OFF_CP + NUM_CORNERS);
    this.co = bytes.subarray(OFF_CO, OFF_CO + NUM_CORNERS);
    this.ep = bytes.subarray(OFF_EP, OFF_EP + NUM_EDGES);
    this.eo = bytes.subarray(OFF_EO, OFF_EO + NUM_EDGES);
    this.centers = bytes.subarray(OFF_CENTERS, OFF_CENTERS + NUM_CENTERS);
  }

  /** A freshly-solved cube in the standard orientation. */
  static solved(): CubeState {
    const state = new CubeState();
    for (let i = 0; i < NUM_CORNERS; i++) state.cp[i] = i;
    for (let i = 0; i < NUM_EDGES; i++) state.ep[i] = i;
    for (let i = 0; i < NUM_CENTERS; i++) state.centers[i] = i;
    return state;
  }

  clone(): CubeState {
    return new CubeState(this.bytes.slice());
  }

  /** Overwrite this state's contents with another's. Allocation-free. */
  copyFrom(other: CubeState): this {
    this.bytes.set(other.bytes);
    return this;
  }

  equals(other: CubeState): boolean {
    for (let i = 0; i < STATE_BYTES; i++) {
      if (this.bytes[i] !== other.bytes[i]) return false;
    }
    return true;
  }

  /**
   * Fully solved *and* in the standard orientation.
   *
   * Most reconstructions do not end here — a solve containing an odd number of `x`
   * rotations ends solved but rotated. Use {@link isSolvedIgnoringOrientation} to verify
   * reconstructions.
   */
  isSolved(): boolean {
    for (let i = 0; i < NUM_CORNERS; i++) {
      if (this.cp[i] !== i || this.co[i] !== 0) return false;
    }
    for (let i = 0; i < NUM_EDGES; i++) {
      if (this.ep[i] !== i || this.eo[i] !== 0) return false;
    }
    for (let i = 0; i < NUM_CENTERS; i++) {
      if (this.centers[i] !== i) return false;
    }
    return true;
  }

  /** A stable string key, for use in maps and sets. */
  key(): string {
    return String.fromCharCode(...this.bytes);
  }
}
