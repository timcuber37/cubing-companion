/**
 * Generates `src/tables.generated.ts` from cubing.js's 3x3x3 KPuzzle definition.
 *
 * Why generate rather than hand-write: the tables are pure convention. Typing 54 of them
 * by hand invites transcription errors that only surface as subtly-wrong analysis much
 * later. Deriving them from a mature reference makes them correct by construction, and
 * adopting cubing.js's exact piece indexing means our state is directly comparable to a
 * KPattern in tests and directly interoperable with the twisty player and solvers later.
 *
 * The runtime engine has no cubing.js dependency in its hot path — only `notation.ts`
 * (parsing) and `scramble.ts` import it.
 *
 * Run: npm run generate -w @cubing-companion/engine
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cube3x3x3 } from "cubing/puzzles";

/**
 * Canonical move families, in table order. Aliases (`u` for `Uw`, `Rv` for `x`, ...) are
 * resolved to these by `moves.ts` before lookup.
 *
 * `2U`-style single-inner-layer moves are deliberately excluded: they are not `u`
 * (verified against cubing.js) and never appear in CFOP reconstructions.
 */
const FAMILIES = [
  "U", "D", "L", "R", "F", "B",
  "Uw", "Dw", "Lw", "Rw", "Fw", "Bw",
  "M", "E", "S",
  "x", "y", "z",
] as const;

/** Quarter-turn counts we tabulate. 3 is the same as -1; `moves.ts` normalizes into 1..3. */
const AMOUNTS = [1, 2, 3] as const;

function suffix(amount: number): string {
  return amount === 1 ? "" : amount === 2 ? "2" : "'";
}

const kpuzzle = await cube3x3x3.kpuzzle();

const rows: string[] = [];
for (const family of FAMILIES) {
  for (const amount of AMOUNTS) {
    const alg = `${family}${suffix(amount)}`;
    const t = kpuzzle.algToTransformation(alg).transformationData;

    const corners = t.CORNERS;
    const edges = t.EDGES;
    const centers = t.CENTERS;
    if (!corners || !edges || !centers) {
      throw new Error(`missing orbit data for ${alg}`);
    }

    // Center orientation (twist) is invisible on a standard 3x3 and is dropped; cubing.js
    // itself masks it via `orientationMod: 1` in the default pattern.
    const fields = [
      `cp:[${corners.permutation.join(",")}]`,
      `co:[${corners.orientationDelta.join(",")}]`,
      `ep:[${edges.permutation.join(",")}]`,
      `eo:[${edges.orientationDelta.join(",")}]`,
      `centers:[${centers.permutation.join(",")}]`,
    ].join(", ");
    rows.push(`  /* ${alg.padEnd(3)} */ { ${fields} },`);
  }
}

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run generate -w @cubing-companion/engine
// Source: cubing.js 3x3x3 KPuzzle definition (see scripts/generate-tables.ts).

/** Raw move transformation, in cubing.js KPuzzle indexing. */
export interface RawTransformation {
  readonly cp: readonly number[];
  readonly co: readonly number[];
  readonly ep: readonly number[];
  readonly eo: readonly number[];
  readonly centers: readonly number[];
}

/** Canonical move families, in table order. */
export const FAMILIES = [
${FAMILIES.map((f) => `  ${JSON.stringify(f)},`).join("\n")}
] as const;

export type Family = (typeof FAMILIES)[number];

/**
 * Indexed by \`familyIndex * 3 + (amount - 1)\`, where amount is a normalized
 * quarter-turn count in 1..3.
 */
export const RAW_TRANSFORMATIONS: readonly RawTransformation[] = [
${rows.join("\n")}
];
`;

const target = fileURLToPath(new URL("../src/tables.generated.ts", import.meta.url));
await writeFile(target, out, "utf8");
console.log(`wrote ${target} (${FAMILIES.length} families x ${AMOUNTS.length} amounts)`);
