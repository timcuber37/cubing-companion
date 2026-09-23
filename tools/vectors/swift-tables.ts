/**
 * Emits the engine's move tables as Swift.
 *
 * Run: npm run swift-tables
 *
 * The tables are derived from cubing.js's 3x3x3 definition and committed as
 * `tables.generated.ts`; this converts that same data into a Swift source file so the port has no
 * runtime file to load and no bundle path to get wrong. Generated from the TypeScript rather than
 * re-derived from cubing.js, so the two implementations cannot disagree about what a move *is* —
 * only about what they do with it, which is what the vectors test.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAMILIES, RAW_TRANSFORMATIONS } from "@cubing-companion/engine/tables";

const OUT = fileURLToPath(
  new URL("../../swift/CubingCore/Sources/CubingCore/Tables.generated.swift", import.meta.url),
);
mkdirSync(fileURLToPath(new URL("../../swift/CubingCore/Sources/CubingCore/", import.meta.url)), {
  recursive: true,
});

const list = (values: readonly number[]) => `[${values.join(", ")}]`;

const transformations = RAW_TRANSFORMATIONS.map(
  (raw) =>
    `    Transformation(cp: ${list(raw.cp)}, co: ${list(raw.co)},\n` +
    `                   ep: ${list(raw.ep)}, eo: ${list(raw.eo)},\n` +
    `                   centers: ${list(raw.centers)}),`,
).join("\n");

writeFileSync(
  OUT,
  `// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run swift-tables
// Source: packages/engine/src/tables.generated.ts, itself generated from cubing.js.
//
// Three entries per family, for quarter turns of 1, 2 and 3.

/// A move's effect, in the same indexing as \`CubeState\`.
public struct Transformation: Sendable {
    public let cp: [UInt8]
    public let co: [UInt8]
    public let ep: [UInt8]
    public let eo: [UInt8]
    public let centers: [UInt8]
}

/// Canonical move families, in table order.
public let families: [String] = [
${FAMILIES.map((f) => `    "${f}",`).join("\n")}
]

public let transformations: [Transformation] = [
${transformations}
]
`,
);
console.log(`  ${FAMILIES.length} families, ${RAW_TRANSFORMATIONS.length} transformations -> Tables.generated.swift`);
