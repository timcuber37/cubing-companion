import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMoves, CubeState, Face, normalizeOrientation, parseMoves, toFacelets } from "@cubing-companion/engine";
import { GEOMETRY, isSlotSolved, segmentFromState } from "@cubing-companion/analysis";
import { crossDistance, solveCross } from "@cubing-companion/solver";
import fixtures from "../../../packages/engine/test/fixtures/reconstructions.json";
import type { DiffRequest, NextPairRequest, PlanRequest, PlanResponse } from "../workers/planner.worker";
import { scorerFor } from "@cubing-companion/planner";

// The worker asks the planner for a scorer; stubbing that one export is how these tests run both
// with a model and without one. Everything else in the package is the real thing — the point is to
// exercise the search and the fallbacks, not to fake them.
vi.mock("@cubing-companion/planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cubing-companion/planner")>()),
  scorerFor: vi.fn(() => null),
}));

type Request = PlanRequest | NextPairRequest | DiffRequest;
const worker = {
  onmessage: null as ((event: { data: Request }) => Promise<void>) | null,
  postMessage: vi.fn<(message: PlanResponse) => void>(),
};
let id = 0;
beforeAll(async () => {
  vi.stubGlobal("self", worker);
  await import("../workers/planner.worker");
});
beforeEach(() => {
  vi.mocked(scorerFor).mockReturnValue(null);
});
afterAll(() => vi.unstubAllGlobals());

async function request(input: Omit<NextPairRequest, "id"> | Omit<PlanRequest, "id"> | Omit<DiffRequest, "id">) {
  const messages: PlanResponse[] = [];
  const current = ++id;
  worker.postMessage.mockImplementation((message) => { if (message.id === current) messages.push(message); });
  await worker.onmessage!({ data: { ...input, id: current } as Request });
  await vi.waitFor(() => expect(messages.some((m) => ["done", "next-pair", "diff", "error"].includes(m.kind))).toBe(true), { timeout: 10_000 });
  expect(messages.find((m) => m.kind === "error")).toBeUndefined();
  return messages;
}

const start = applyMoves(CubeState.solved(), parseMoves("B U2 R2 D L' R2 L' D2 R2"));
const state = applyMoves(applyMoves(start, solveCross(start, Face.D)!), parseMoves("x y2"));

describe("planner worker lookahead", () => {
  it("ranks a better continuation without a model and includes executable orientation setup", async () => {
    const messages = await request({ kind: "next-pair", facelets: toFacelets(state), crossFaces: [Face.D] });
    const response = messages.find((m) => m.kind === "next-pair")!;
    expect(response.learned).toBe(false);
    expect(response.ranked[0]!.slot).toBe("BL");
    expect(response.ranked[0]!.lookahead!.totalTurns).toBe(9);
    for (const option of response.ranked) {
      if (!option.lookahead) continue;
      const after = normalizeOrientation(applyMoves(state, parseMoves(option.lookahead.branch)));
      expect(crossDistance(after, Face.D)).toBe(0);
      expect(GEOMETRY[Face.D]!.slots.filter((slot) => isSlotSolved(after, slot)).length).toBeGreaterThanOrEqual(2);
      expect(option.lookahead.steps[0]!.moves).toBe(option.moves);
      const bySteps = applyMoves(state, parseMoves(option.lookahead.steps.map((step) => step.moves).join(" ")));
      expect(normalizeOrientation(bySteps).equals(after)).toBe(true);
    }
  });

  it("keeps first-pair model preference separate from the continuation ranking", async () => {
    vi.mocked(scorerFor).mockReturnValue(async (rows) => rows.map((row) => -10 * row[0]!));
    const messages = await request({ kind: "next-pair", facelets: toFacelets(state), crossFaces: [Face.D] });
    const response = messages.find((m) => m.kind === "next-pair")!;
    expect(response.learned).toBe(true);
    expect(response.ranked[0]!.slot).toBe("BL");
    expect(response.ranked.find((r) => r.slot === "BR")!.confidence).toBeGreaterThan(response.ranked[0]!.confidence);
  });

  it("ranks with the weights this build actually ships", async () => {
    // Every other test here stubs the scorer, which means none of them would notice if the
    // bundled weights, `mlp.ts`, `scorer.ts` and the worker stopped agreeing. This one runs the
    // real thing end to end — the check that used to need a browser and a page at `/selftest`.
    const planner = await vi.importActual<typeof import("@cubing-companion/planner")>(
      "@cubing-companion/planner",
    );
    vi.mocked(scorerFor).mockImplementation(planner.scorerFor);

    const messages = await request({ kind: "next-pair", facelets: toFacelets(state), crossFaces: [Face.D] });
    const response = messages.find((m) => m.kind === "next-pair")!;
    expect(response.learned).toBe(true);
    expect(response.ranked.length).toBeGreaterThan(0);
    // A ranking, not a tie: the model has to actually separate the options.
    expect(new Set(response.ranked.map((pair) => pair.confidence)).size).toBe(response.ranked.length);
    for (const pair of response.ranked) {
      expect(pair.confidence).toBeGreaterThan(0);
      expect(pair.confidence).toBeLessThan(1);
    }
  });

  it("enables deeper openings by default", async () => {
    const messages = await request({ kind: "plan", facelets: toFacelets(start), crossFaces: [Face.D], keep: 1 });
    const response = messages.find((m) => m.kind === "colour")!;
    const opening = response.plan.crossPlusTwo![0]!;
    const after = normalizeOrientation(applyMoves(start, [...opening.setup, ...opening.moves]));
    expect(crossDistance(after, Face.D)).toBe(0);
    expect(GEOMETRY[Face.D]!.slots.filter((slot) => isSlotSolved(after, slot)).length).toBeGreaterThanOrEqual(2);
  });

  it("abandons remaining colours when a newer request arrives", async () => {
    const messages: PlanResponse[] = [];
    worker.postMessage.mockImplementation((message) => { messages.push(message); });
    const oldId = ++id;
    const oldRequest = worker.onmessage!({ data: {
      id: oldId, kind: "plan", facelets: toFacelets(start), crossFaces: [Face.D, Face.U], crossOnly: true,
    } });
    const newId = ++id;
    await worker.onmessage!({ data: {
      id: newId, kind: "next-pair", facelets: toFacelets(CubeState.solved()), crossFaces: [Face.D],
    } });
    await oldRequest;
    await vi.waitFor(() => expect(messages.some((m) => m.id === newId && m.kind === "next-pair")).toBe(true));
    expect(messages.filter((m) => m.id === oldId && m.kind === "colour")).toHaveLength(1);
    expect(messages.some((m) => m.id === oldId && m.kind === "done")).toBe(false);
  });

  it("attaches playable search advice to recorded-solve analysis", async () => {
    const fixture = fixtures.fixtures.find((f) => f.id === 1200)!;
    const raw = applyMoves(CubeState.solved(), parseMoves(fixture.scramble));
    const solution = parseMoves(fixture.solution);
    const crossFace = segmentFromState(raw, solution).segmentation!.crossFace;
    const messages = await request({ kind: "diff", startFacelets: toFacelets(raw), solution: fixture.solution });
    const response = messages.find((m) => m.kind === "diff")!;
    expect(response.cross!.lookahead).toBeDefined();
    expect(response.pairs.some((pair) => pair.lookahead)).toBe(true);
    for (const pair of response.pairs) {
      if (!pair.lookahead) continue;
      const at = applyMoves(raw, solution.slice(0, pair.at));
      const after = normalizeOrientation(applyMoves(at, parseMoves(pair.lookahead.forecast.branch)));
      expect(crossDistance(after, crossFace)).toBe(0);
      expect(GEOMETRY[crossFace]!.slots.filter((slot) => isSlotSolved(after, slot)).length).toBeGreaterThanOrEqual(pair.step + 2);
    }
  });
});
