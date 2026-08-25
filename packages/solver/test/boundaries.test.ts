/**
 * Architecture guard, matching the one in `analysis`.
 *
 * `PLAN.md` requires analysis-side code to be input-agnostic. The solver answers "what could
 * have been done here", which has nothing to do with whether the position arrived from a
 * Bluetooth cube or a text file — and one convenient type import is all it would take for that
 * to stop being true.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

describe("dependency boundaries", () => {
  const files = sourceFiles(SRC);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("depends only on the engine and analysis", () => {
    const external = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /from\s+["']([^"']+)["']/g,
      )) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual([
      "@cubing-companion/analysis",
      "@cubing-companion/engine",
    ]);
  });

  it("never reaches for the input or capture layers", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*(cube-link|\/session)/.test(text)) {
        offenders.push(file.replace(SRC, "src"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
