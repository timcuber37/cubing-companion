/**
 * Architecture guard.
 *
 * `PLAN.md` requires the analysis engine to be input-agnostic — "the smart cube is an input
 * adapter, never a dependency of the analysis code". That is stated in three READMEs and
 * enforced by nothing, which is how such rules quietly stop being true. A single convenience
 * import of a `MoveEvent` type would do it.
 *
 * Reading the source is cruder than a lint rule but needs no tooling and fails loudly.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("dependency boundaries", () => {
  const files = sourceFiles(SRC);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("never imports the cube input layer", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*cube-link/.test(text)) {
        offenders.push(file.replace(SRC, "src"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports the corpus package", () => {
    // The evaluation script reads `data/corpus.jsonl` as a file on purpose, so that the
    // library keeps exactly one dependency.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*\/corpus/.test(text)) {
        offenders.push(file.replace(SRC, "src"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("depends on the engine and nothing else outside itself", () => {
    const external = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /from\s+["']([^"']+)["']/g,
      )) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) continue; // internal
        external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(["@cubing-companion/engine"]);
  });
});
