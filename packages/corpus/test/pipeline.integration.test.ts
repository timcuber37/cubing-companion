/**
 * End-to-end pipeline check against real cached pages.
 *
 * Skips when the cache is empty, which is the case in CI — `data/` is gitignored, so
 * these run locally after a crawl. The unit tests cover behaviour with synthetic
 * fixtures; this one guards against real-world markup drifting away from the parser.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EmptyReconstructionError,
  parseSolvePage,
  peekEvent,
} from "../src/parse.ts";
import { segmentSolve } from "../src/segment.ts";
import { Method } from "../src/types.ts";
import { CACHE_DIR } from "../src/paths.ts";

const cachedPages = existsSync(CACHE_DIR)
  ? readdirSync(CACHE_DIR).filter((f) => f.endsWith(".html"))
  : [];

describe.skipIf(cachedPages.length === 0)("pipeline against cached pages", () => {
  const parsed = cachedPages.map((file) => {
    const id = Number(file.replace(".html", ""));
    return { id, html: readFileSync(join(CACHE_DIR, file), "utf8") };
  });

  /**
   * 3x3 pages only, mirroring the pipeline's ordering. The event guard has to come first:
   * other puzzles do not all carry an alg.cubing.net permalink (Square-1 links to
   * cubedb.net), so parsing them as 3x3 would throw.
   */
  const threeByThreePages = parsed.filter(({ html }) => peekEvent(html) === "3x3");

  /** Pages carrying an actual reconstruction. Placeholder entries are excluded. */
  const withReconstruction = threeByThreePages.flatMap(({ id, html }) => {
    try {
      return [parseSolvePage(html, id)];
    } catch (cause) {
      if (cause instanceof EmptyReconstructionError) return [];
      throw cause;
    }
  });

  it("finds 3x3 solves in the cache", () => {
    expect(threeByThreePages.length).toBeGreaterThan(0);
    expect(withReconstruction.length).toBeGreaterThan(0);
  });

  it("parses every cached 3x3 page, allowing for placeholder entries", () => {
    // Some pages exist with metadata but no reconstruction (`setup=&alg=`). Those are a
    // data gap, not a parse failure — anything else is a bug.
    const failures: string[] = [];
    let placeholders = 0;
    for (const { id, html } of threeByThreePages) {
      try {
        parseSolvePage(html, id);
      } catch (cause) {
        if (cause instanceof EmptyReconstructionError) placeholders++;
        else failures.push(`${id}: ${(cause as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(placeholders / threeByThreePages.length).toBeLessThan(0.25);
  });

  it("extracts a scramble, solution, and event from every real reconstruction", () => {
    for (const solve of withReconstruction) {
      expect(solve.scramble, `solve ${solve.id}`).not.toBe("");
      expect(solve.solution, `solve ${solve.id}`).not.toBe("");
      expect(solve.event, `solve ${solve.id}`).not.toBeNull();
    }
  });

  it("verifies the overwhelming majority of 3x3 CFOP solves against the engine", () => {
    const threeByThree = withReconstruction;
    expect(threeByThree.length).toBeGreaterThan(0);

    const results = threeByThree.map((raw) => ({ raw, result: segmentSolve(raw) }));
    const cfop = results.filter(
      ({ result }) => result.record?.method === Method.CFOP,
    );
    const failedToSolve = results.filter(
      ({ result }) => result.error?.reason === "does-not-solve",
    );

    expect(cfop.length).toBeGreaterThan(0);
    // A handful of bad reconstructions is expected in community data; a large share
    // failing means the engine or the parser has regressed, not that the data is dirty.
    expect(failedToSolve.length / threeByThree.length).toBeLessThan(0.1);
  });

  it("recognizes essentially every label used by accepted CFOP solves", () => {
    const unknown = new Map<string, number>();
    let cfopSolves = 0;
    for (const raw of withReconstruction) {
      const { record, unknownLabels } = segmentSolve(raw);
      if (record?.method !== Method.CFOP) continue;
      cfopSolves++;
      for (const label of unknownLabels) {
        unknown.set(label, (unknown.get(label) ?? 0) + 1);
      }
    }

    // A rate, not zero. At full-corpus scale a residue of genuine error commentary
    // survives — `missed cross`, `OLL fail`, `not a Ga perm bud` — and those *should*
    // stay unrecognized: mapping them onto real phases would put anomalous solves into
    // the baselines. The threshold is still tight enough that breaking a common label
    // (say `xcross`) blows straight through it.
    const occurrences = [...unknown.values()].reduce((a, b) => a + b, 0);
    const rate = occurrences / Math.max(cfopSolves, 1);
    // Reported rather than merely counted, so a failure names what to add to labels.ts.
    const report = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    expect({ rate: rate < 0.005, report }).toEqual({ rate: true, report });
  });
});
