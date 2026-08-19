/**
 * Runtime move tables: the generated data converted once into typed arrays, plus the
 * family-name lookup (including aliases) used by `moves.ts`.
 */
import {
  FAMILIES,
  RAW_TRANSFORMATIONS,
  type Family,
} from "./tables.generated.ts";

export { FAMILIES, type Family };

/** A move's effect, in the same indexing as {@link CubeState}. */
export interface Transformation {
  readonly cp: Uint8Array;
  readonly co: Uint8Array;
  readonly ep: Uint8Array;
  readonly eo: Uint8Array;
  readonly centers: Uint8Array;
}

export const TRANSFORMATIONS: readonly Transformation[] = RAW_TRANSFORMATIONS.map(
  (raw) => ({
    cp: Uint8Array.from(raw.cp),
    co: Uint8Array.from(raw.co),
    ep: Uint8Array.from(raw.ep),
    eo: Uint8Array.from(raw.eo),
    centers: Uint8Array.from(raw.centers),
  }),
);

/**
 * Alias families accepted on input, mapped to a canonical family and a direction.
 *
 * `sign: -1` means the alias turns the opposite way from the canonical family, so `Lv`
 * (the rotation following L) is `x'`.
 *
 * Deliberately absent: `2U`-style single-inner-layer moves. `2U` is not `u` — verified
 * against cubing.js — and it does not occur in CFOP reconstructions.
 */
const ALIASES: Readonly<Record<string, { family: Family; sign: 1 | -1 }>> = {
  u: { family: "Uw", sign: 1 },
  d: { family: "Dw", sign: 1 },
  l: { family: "Lw", sign: 1 },
  r: { family: "Rw", sign: 1 },
  f: { family: "Fw", sign: 1 },
  b: { family: "Bw", sign: 1 },
  Uv: { family: "y", sign: 1 },
  Dv: { family: "y", sign: -1 },
  Rv: { family: "x", sign: 1 },
  Lv: { family: "x", sign: -1 },
  Fv: { family: "z", sign: 1 },
  Bv: { family: "z", sign: -1 },
};

const FAMILY_INDEX = new Map<string, number>(
  FAMILIES.map((family, index) => [family, index]),
);

export interface ResolvedFamily {
  /** Index into {@link FAMILIES}. */
  readonly index: number;
  /** Canonical family name. */
  readonly family: Family;
  /** Multiply the written amount by this to get the canonical amount. */
  readonly sign: 1 | -1;
}

/** Resolve a written family name (canonical or alias) or return `undefined`. */
export function resolveFamily(name: string): ResolvedFamily | undefined {
  const direct = FAMILY_INDEX.get(name);
  if (direct !== undefined) {
    return { index: direct, family: FAMILIES[direct]!, sign: 1 };
  }
  const alias = ALIASES[name];
  if (alias === undefined) return undefined;
  return {
    index: FAMILY_INDEX.get(alias.family)!,
    family: alias.family,
    sign: alias.sign,
  };
}

/**
 * Look up the transformation for a family index and a normalized quarter-turn count.
 *
 * @param amount must be 1, 2, or 3 — callers normalize first.
 */
export function transformationFor(
  familyIndex: number,
  amount: 1 | 2 | 3,
): Transformation {
  return TRANSFORMATIONS[familyIndex * 3 + (amount - 1)]!;
}
