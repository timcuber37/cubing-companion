/**
 * Architecture guard.
 *
 * The engine is the dependency root, and everything downstream imports it. That makes its module
 * graph everyone's module graph — so one convenience import here is paid for by every consumer.
 *
 * `scramble.ts` is the live example. It statically imports `cubing/scramble` and `cubing/search`,
 * which between them pull in a Web Worker and a base64-embedded WASM module (inlined in
 * `cubing/dist/lib/cubing/chunks/twips_wasm_bg-*.js`, which is why searching for `.wasm` files
 * finds nothing). While `src/index.ts` re-exported it, importing `applyMoves` was enough to drag
 * all of that in. Web bundlers tree-shake it away and nobody notices; a runtime without `Worker`
 * or `WebAssembly` cannot, and neither can a bundler that does not tree-shake across the boundary.
 *
 * So `scramble.ts` has its own entry point, `@cubing-companion/engine/scramble`, and the barrel
 * stays free of it. This test is what keeps that true — it is a one-line convenience export away
 * from silently regressing, and the symptom would appear on a phone rather than here.
 *
 * Reading the source is cruder than a lint rule but needs no tooling and fails loudly.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The one file allowed to reach for cubing.js's solver, and so for a Worker and WASM. */
const SEARCH_OWNER = "scramble.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

describe("dependency boundaries", () => {
  const files = sourceFiles(SRC);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("keeps the search solver out of every file but one", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (basename(file) === SEARCH_OWNER) continue;
      for (const specifier of importsOf(file)) {
        // `cubing/alg` is pure notation parsing and carries no worker or WASM; the solver
        // entry points are the ones that do.
        if (/^cubing\/(scramble|search|twisty|puzzles)$/.test(specifier)) {
          offenders.push(`${file.replace(SRC, "src")} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not re-export scramble generation from the barrel", () => {
    // The whole point of the subpath entry: importing the barrel must not reach `scramble.ts`.
    const barrel = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(barrel).not.toMatch(/from\s+["']\.\/scramble\.ts["']/);
  });

  it("depends on cubing.js and nothing else outside itself", () => {
    const external = new Set<string>();
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith(".")) continue; // internal
        external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(["cubing/alg", "cubing/scramble", "cubing/search"]);
  });
});
