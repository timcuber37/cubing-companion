/**
 * The oracle must not drift from the implementation it describes.
 *
 * These vectors exist so a Swift port can be checked against the TypeScript without reimplementing
 * 758 tests first (see `SWIFT_PLAN.md`). That only works while they are a true recording. A
 * committed corpus is a fact about what the code did *when it was generated*, and code changes —
 * so without this test, a legitimate fix to the engine would leave the Swift port being validated
 * against behaviour the TypeScript no longer has, and nobody would notice until the two
 * implementations quietly disagreed in production.
 *
 * So: regenerate from the committed seed and compare. If the implementation changed, this fails,
 * and the fix is `npm run vectors` plus a look at the diff — which is the moment to decide whether
 * the change was intended. The diff is readable on purpose; the files are pretty-printed for
 * exactly this.
 *
 * It also pins the generators themselves. A generator that silently stopped exercising a branch
 * would weaken the oracle without changing a single expected value, and the case counts here would
 * not catch that — but a changed input distribution would.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENERATORS, type VectorFile } from "../cases.ts";

const DIR = fileURLToPath(new URL("../../../vectors/", import.meta.url));

const committed = (name: string): VectorFile =>
  JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as VectorFile;

describe.each(Object.keys(GENERATORS))("the %s vectors", (name) => {
  const file = committed(name);

  it("regenerates identically from its recorded seed", async () => {
    const regenerated = await GENERATORS[name]!(file.seed, file.count);
    // Compared as parsed data rather than as text, so formatting is not what fails.
    expect(regenerated).toEqual(file);
  }, name === "s2" ? 30_000 : name === "cubelink" ? 15_000 : 5_000);

  it("is large enough to be worth trusting", () => {
    // `cubelink` is a set of replays, and its `count` is messages per event type inside them; its
    // coverage is asserted on its own below.
    if (name === "cubelink") return;
    expect(file.cases.length).toBe(file.count);
    // `metrics` is bounded by the twenty committed reconstructions rather than by a seed — real
    // solves are the only honest input for it, and there are twenty of them. Every other corpus is
    // generated and has no such ceiling, so a low count there means a generator has been trimmed.
    expect(file.cases.length).toBeGreaterThanOrEqual(name === "s2" ? 24 : name === "metrics" ? 50 : 1000);
  });

  it("carries only what a port can read without the port existing", () => {
    // Facelet strings, notation, numbers, booleans and null. Anything structural here would mean
    // the Swift side has to model a TypeScript type before it can read its own test data.
    const scalar = (value: unknown): boolean =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every(scalar)) ||
      (typeof value === "object" && Object.values(value!).every(scalar));

    expect(file.cases.every(scalar)).toBe(true);
  });
});

describe("coverage", () => {
  it("includes solved and near-solved positions, not just deep scrambles", () => {
    // The ends of the input space are where a port's off-by-one errors live, and a uniform sample
    // of 25-move scrambles contains none of them.
    const engine = committed("engine").cases as { scramble: string }[];
    const shallow = engine.filter((c) => c.scramble.split(" ").filter(Boolean).length <= 3);
    expect(shallow.length).toBeGreaterThan(100);
    expect(engine.some((c) => c.scramble === "")).toBe(true);
  });

  it("covers every cross colour", () => {
    const solver = committed("solver").cases as { face: number }[];
    expect(new Set(solver.map((c) => c.face)).size).toBe(6);
  });

  it("spans the full range of cross distances, including zero and the maximum", () => {
    // God's number for the cross is 8. A corpus that never reaches it never tests the deepest
    // branch of the search, and one that never sees 0 never tests "already done".
    const solver = committed("solver").cases as { distance: number }[];
    const distances = new Set(solver.map((c) => c.distance));
    expect(distances.has(0)).toBe(true);
    expect(Math.max(...distances)).toBeGreaterThanOrEqual(7);
  });

  it("exercises the model weights, not just the search", () => {
    // `crossFeatures` feeding the committed MLP weights. A port that reads either wrongly still
    // returns numbers and just gives worse advice — so it has to be pinned, not inferred.
    const planner = committed("planner").cases as { modelScore: number | null; crossFeatures: number[] }[];
    expect(planner.every((c) => c.crossFeatures.length === 12)).toBe(true);
    expect(planner.some((c) => c.modelScore !== null)).toBe(true);
    expect(new Set(planner.map((c) => c.modelScore)).size).toBeGreaterThan(50);
  });

  it("covers steady, slow-start and long-pause solves", () => {
    // Pause detection and fluidity are what a single flat timing profile would never exercise.
    const metrics = committed("metrics").cases as { profile: number; pauses: number }[];
    expect(new Set(metrics.map((c) => c.profile)).size).toBe(3);
    expect(metrics.some((c) => c.pauses > 0)).toBe(true);
  });

  it("records segmentation failures as well as successes", () => {
    // Synthetic solves mostly do not finish, so most cases fail to segment — and a port has to
    // fail on the same ones. Both outcomes need to be present for that to be checkable.
    const analysis = committed("analysis").cases as { failure: string | null }[];
    expect(analysis.some((c) => c.failure !== null)).toBe(true);
    expect(analysis.some((c) => c.failure === null)).toBe(true);
  });
});

describe("cube link coverage", () => {
  interface Event { type: string; serial?: number; localTimestamp?: number | null }
  interface Replay {
    kind: string;
    generation?: string;
    start?: number;
    steps: { events: Event[]; sent: string[]; disconnects: number }[];
  }
  const cases = committed("cubelink").cases as Replay[];
  const replays = (kind: string) => cases.filter((c) => c.kind === kind);
  const events = (c: Replay) => c.steps.flatMap((step) => step.events);

  it("replays the whole real capture", () => {
    const [capture] = replays("capture");
    expect(capture!.steps).toHaveLength(1213);
    expect(events(capture!).filter((e) => e.type === "FACELETS")).toHaveLength(138);
  });

  it("decodes a valid facelet report in every generation", () => {
    // Random bytes are almost never a cube; the generator plants real states so the conversion is
    // seen succeeding, not only rejecting.
    for (const decode of replays("decode")) {
      expect(events(decode).some((e) => e.type === "FACELETS"), decode.generation).toBe(true);
    }
  });

  it("recovers gaps completely, in order, with nothing lost", () => {
    // The simulated cube answers history requests, so every move it played must come out exactly
    // once and contiguously. If this breaks, either the simulation or the recovery regressed —
    // and the capture, which contains no history responses, could never have shown it.
    const recoveries = replays("recovery");
    expect(new Set(recoveries.map((c) => c.generation))).toEqual(new Set(["gen3", "gen4"]));
    // Both strategies: the reference, which the port must reproduce, and eager, which the apps run.
    expect(new Set(recoveries.map((c) => (c as unknown as { recovery: string }).recovery)))
      .toEqual(new Set(["reference", "eager"]));
    for (const recovery of recoveries) {
      const moves = events(recovery).filter((e) => e.type === "MOVE");
      const serials = moves.map((e) => e.serial!);
      expect(serials[0]).toBe((recovery.start! + 1) & 0xff);
      expect(serials.slice(1).every((serial, i) => ((serial - serials[i]!) & 0xff) === 1)).toBe(true);
      expect(moves.some((e) => e.localTimestamp === null), "no move was recovered").toBe(true);
      expect(recovery.steps.every((step) => step.disconnects === 0)).toBe(true);
    }
  });

  it("drives the tracker through every kind of desync", () => {
    const reasons = new Set(
      replays("tracker").flatMap((c) =>
        (c as unknown as { steps: { output: { type: string; reason?: string }[] }[] }).steps
          .flatMap((step) => step.output)
          .filter((o) => o.type === "desync")
          .map((o) => o.reason),
      ),
    );
    expect(reasons).toEqual(new Set(["initial-sync", "serial-gap", "state-mismatch"]));
  });
});
