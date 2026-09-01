/**
 * Naming the colours.
 *
 * `engine` deliberately has no notion of colour — a `Face` is a slot in space, and centres are
 * tracked as indices. That is the right call there, but a planner has to say "yellow down, green
 * in front", because that is how a person orients a cube. Nobody thinks "rotate x y'".
 *
 * The mapping is the WCA-standard scheme, the one every modern speedcube ships with and the one
 * `gan-web-bluetooth` assumes: white opposite yellow, green opposite blue, red opposite orange,
 * with white up and green front giving red on the right. A cube stickered otherwise would be
 * named wrongly here — nothing else would break, since every calculation is done on indices.
 */
import { Face } from "@cubing-companion/engine";
import type { Slot } from "@cubing-companion/analysis";

export interface Colour {
  readonly face: Face;
  readonly name: string;
  /** For swatches in the UI. */
  readonly hex: string;
}

export const COLOURS: readonly Colour[] = [
  { face: Face.U, name: "white", hex: "#f8fafc" },
  { face: Face.L, name: "orange", hex: "#f97316" },
  { face: Face.F, name: "green", hex: "#22c55e" },
  { face: Face.R, name: "red", hex: "#ef4444" },
  { face: Face.B, name: "blue", hex: "#3b82f6" },
  { face: Face.D, name: "yellow", hex: "#eab308" },
];

const BY_FACE = new Map(COLOURS.map((colour) => [colour.face, colour]));

export function colourOf(face: Face): Colour {
  const colour = BY_FACE.get(face);
  if (!colour) throw new RangeError(`not a face: ${face}`);
  return colour;
}

export const colourName = (face: Face): string => colourOf(face).name;

/**
 * A slot named by its two side colours — "green-red" — instead of by position.
 *
 * Position names like FR are relative to a frame, and during a solve the frame is whatever the
 * solver's hands last made it: the pair called FR is at the front-right only if the cube is held
 * the way the namer imagined. The colours of a pair never change however the cube is held, which
 * is how solvers actually talk about them.
 *
 * In the normalised frame a slot's `faces` are colour indices directly, so this is a lookup, not
 * a computation. Display-only: `slotName` remains the internal key everywhere the model, the
 * dataset and the search are concerned.
 */
export function slotColours(slot: Slot): string {
  return slot.faces.map((face) => colourName(face)).join("-");
}

/** The two swatch colours for a slot, for UIs that want to show the pair rather than name it. */
export function slotSwatches(slot: Slot): readonly [string, string] {
  return [colourOf(slot.faces[0]).hex, colourOf(slot.faces[1]).hex];
}
