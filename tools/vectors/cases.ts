/**
 * What the oracle records.
 *
 * One generator per package, each producing `(input, expected)` pairs in terms a Swift test can
 * read without first porting any TypeScript types: **facelet strings, notation strings, numbers
 * and booleans**. Nothing here emits a `CubeState`, a `Move` object or a piece array, because a
 * vector that requires the port to already exist is no use for building the port.
 *
 * Coverage is deliberately broad rather than deep. A hand-written test checks one interesting
 * case; a generator checks ten thousand ordinary ones, and between them they catch different
 * things. These are the ordinary ones — the existing 758 tests remain the interesting ones, and
 * both should be ported in spirit.
 */
import {
  applyMoves,
  CubeState,
  Face,
  fromFacelets,
  invertMove,
  isSolvedIgnoringOrientation,
  isStandardOrientation,
  normalizeOrientation,
  parseMoves,
  serializeMoves,
  toFacelets,
} from "@cubing-companion/engine";
import { isCrossBuilt, isSlotSolved, segmentFromState, GEOMETRY } from "@cubing-companion/analysis";
import { crossDistance, enumerateAllXcrosses, enumerateCross, enumerateNextPair, pairDistance, respellAsWide, solveCross } from "@cubing-companion/solver";
import { slotName } from "@cubing-companion/analysis";
import { computeMetrics, scoreSolve } from "@cubing-companion/metrics";
import {
  awkwardTurns,
  comfortScore,
  crossFeatures,
  pairFeatures,
  planColour,
  scoreRows,
  WEIGHTS,
} from "@cubing-companion/planner";
import RECONSTRUCTIONS from "../../packages/engine/test/fixtures/reconstructions.json" with { type: "json" };
import { integer, pick, positions, seeded, serialize, type Position } from "./random.ts";

const FACES: Face[] = [0, 1, 2, 3, 4, 5] as Face[];

export interface VectorFile {
  /** What produced this, so a stale file is recognisable. */
  readonly generator: string;
  readonly seed: number;
  readonly count: number;
  readonly cases: readonly unknown[];
}

/**
 * Engine: applying moves, notation round-trips, orientation.
 *
 * The foundation — every other vector file is stated in terms the engine defines, so if these
 * disagree nothing downstream means anything.
 */
export function engineVectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases = positions(random, count).map((position) => {
    const state = fromFacelets(position.facelets);
    const extra = parseMoves(serialize([...parseMoves(position.scramble)].slice(0, 3)));
    return {
      scramble: position.scramble,
      facelets: position.facelets,
      // Notation must survive a round trip, including the empty sequence.
      reserialized: serializeMoves(parseMoves(position.scramble)),
      // Applying more moves on top, so composition is checked rather than just a single apply.
      afterExtra: toFacelets(applyMoves(state, extra)),
      extra: serializeMoves(extra),
      normalized: toFacelets(normalizeOrientation(state)),
      isStandardOrientation: isStandardOrientation(state),
      isSolvedIgnoringOrientation: isSolvedIgnoringOrientation(state),
    };
  });
  return { generator: "engine", seed, count, cases };
}

/**
 * Solver: exact cross distance, and the shape of an enumeration.
 *
 * `crossDistance` is the single most load-bearing number in the project — the planner, the diff
 * and the scoring all rest on it — and it is a pure integer function of a position and a face,
 * which makes it the ideal thing to pin exhaustively.
 */
export function solverVectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases = positions(random, count).map((position) => {
    const state = fromFacelets(position.facelets);
    const face = pick(random, FACES);
    const solution = solveCross(state, face);
    // Optimal only: a full enumeration's *set* of candidates is large and order-sensitive, while
    // its optimal length and count are stable facts a port must reproduce.
    const enumerated = enumerateCross(state, face, { maxExtra: 0, maxSolutions: 64 });
    return {
      facelets: position.facelets,
      face,
      distance: crossDistance(state, face),
      // The moves themselves may legitimately differ between implementations — several optimal
      // crosses exist — so what is pinned is that the solution *works* and how long it is.
      solutionLength: solution?.length ?? null,
      solutionSolvesCross:
        solution === null ? null : crossDistance(applyMoves(state, solution), face) === 0,
      optimal: enumerated.optimal,
      optimalCount: enumerated.candidates.length,
      truncated: enumerated.stats.truncated,
    };
  });
  return { generator: "solver", seed, count, cases };
}

/**
 * Analysis: CFOP segmentation, and the predicates underneath it.
 *
 * Solves are synthesised by solving the cross and then applying a short continuation, so the
 * corpus contains positions genuinely part-way through a solve rather than random states that no
 * solver would ever be in.
 */
export function analysisVectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases = positions(random, count).map((position, i) => {
    const state = fromFacelets(position.facelets);
    const face = pick(random, FACES);
    const cross = solveCross(state, face) ?? [];
    const afterCross = applyMoves(state, cross);
    // A few more moves so the solve has something past the cross to segment.
    const extra = parseMoves(
      serialize(
        Array.from({ length: integer(random, 0, 8) }, () =>
          pick(random, parseMoves("R U R' U' F L D B")),
        ),
      ),
    );
    // Half the cases solve the cube outright — the undone scramble, rotations and all — because
    // cross-plus-noise almost never does, and a corpus of "does-not-solve" exercises nothing past
    // the first check. The first version of this generator segmented 8 cases out of 1,200.
    const solution =
      i % 2 === 1
        ? parseMoves(position.scramble).reverse().map(invertMove)
        : [...cross, ...extra];
    const geometry = GEOMETRY[face]!;
    const segmentation = segmentFromState(state, solution);

    return {
      facelets: position.facelets,
      face,
      solution: serializeMoves(solution),
      // Recorded so the predicates below can be checked without a ported solver.
      cross: serializeMoves(cross),
      crossBuiltAfterCross: isCrossBuilt(afterCross, geometry),
      slotsSolvedAfterCross: geometry.slots.filter((slot) => isSlotSolved(afterCross, slot)).length,
      // The segmentation's shape: what it concluded, and where each phase ended. A failure is
      // recorded rather than skipped — a port must fail on the same inputs, for the same reason.
      crossFace: segmentation.segmentation?.crossFace ?? null,
      xcross: segmentation.segmentation?.xcross ?? null,
      freePairs: segmentation.segmentation?.freePairs ?? null,
      failure: segmentation.failure,
      phases:
        segmentation.segmentation?.spans.map((span) => ({
          phase: span.phase,
          start: span.start,
          end: span.end,
        })) ?? null,
    };
  });
  return { generator: "analysis", seed, count, cases };
}

/** Everything the oracle knows how to produce. */
export const GENERATORS: Readonly<
  Record<string, (seed: number, count: number) => VectorFile>
> = {
  engine: engineVectors,
  solver: solverVectors,
  analysis: analysisVectors,
  metrics: metricsVectors,
  planner: plannerVectors,
  s2: s2Vectors,
};

export type { Position };

/**
 * Metrics and scoring, over solves that actually happened.
 *
 * Synthetic solves mostly fail to segment, and a metrics corpus built from failures measures
 * nothing — so these come from `reconstructions.json`, twenty verified reconstructions of real
 * solves by real people. The timings are synthesised, because the reconstructions carry moves and
 * no clock, but they are synthesised deterministically and in several profiles per solve: steady
 * turning, a slow start, and one long mid-solve pause. Pause detection and fluidity are exactly
 * the things a single flat profile would fail to exercise.
 *
 * Recorded as scalars rather than whole objects. A `SolveScore` embeds the corpus distribution it
 * was rated against in every component, which would repeat several kilobytes of identical baseline
 * per case and tell a port nothing it cannot read from `baselines.generated.ts` directly.
 */
export function metricsVectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases: unknown[] = [];

  for (const fixture of RECONSTRUCTIONS.fixtures) {
    const scramble = parseMoves(stripComments(fixture.scramble));
    const solution = parseMoves(stripComments(fixture.solution));
    const state = applyMoves(CubeState.solved(), scramble);
    const segmentation = segmentFromState(state, solution);
    const spans = segmentation.segmentation?.spans;
    if (!spans) continue;

    for (let profile = 0; profile < 3 && cases.length < count; profile++) {
      const timestamps = synthesiseTimings(random, solution.length, profile);
      const metrics = computeMetrics(spans, timestamps);
      const score = scoreSolve(metrics);

      cases.push({
        id: fixture.id,
        profile,
        scramble: serializeMoves(scramble),
        solution: serializeMoves(solution),
        timestamps,
        phases: metrics.phases.map((phase) => ({
          phase: phase.phase,
          turns: phase.turns,
          durationMs: round(phase.durationMs),
          tps: round(phase.tps),
          recognitionMs: round(phase.recognitionMs),
          pausedMs: round(phase.pausedMs),
        })),
        durationMs: round(metrics.durationMs),
        tps: round(metrics.tps),
        pauses: metrics.pauses.length,
        pausedMs: round(metrics.pausedMs),
        longestPauseMs: round(metrics.longestPause?.durationMs ?? 0),
        fluidity: round(metrics.fluidity),
        medianGapMs: round(metrics.medianGapMs),
        pauseThresholdMs: round(metrics.pauseThresholdMs),
        // Value and rating only; the distribution behind them is `BASELINES`, which ports as data.
        components: score.components.map((component) => ({
          label: component.label,
          value: round(component.rated.value),
          rating: round(component.rated.rating),
        })),
      });
    }
  }
  return { generator: "metrics", seed, count: cases.length, cases };
}

/**
 * Planner: the feature vectors the model reads, and the heuristics beside it.
 *
 * `crossFeatures` is the highest-value thing here. If a port computes it even slightly differently
 * the model still returns numbers, the advice just quietly gets worse — the exact failure the
 * PyTorch parity fixture was built to catch on the other side of the same boundary.
 */
export function plannerVectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases = positions(random, count).map((position) => {
    const state = fromFacelets(position.facelets);
    const face = pick(random, FACES);
    const cross = solveCross(state, face) ?? [];
    const plan = planColour(state, face, { keep: 3, crossOnly: true, lookahead: false });

    const features = crossFeatures(cross);
    const weights = WEIGHTS.cross;
    return {
      facelets: position.facelets,
      face,
      crossMoves: serializeMoves(cross),
      // Pure functions of a move sequence: the cheapest things to port and the easiest to get
      // subtly wrong, since both are weighted sums over per-face constants.
      comfort: round(comfortScore(cross)),
      awkward: awkwardTurns(cross),
      crossFeatures: features.map(round),
      // Ties the committed model weights into the oracle: a port that reads them wrongly fails here
      // rather than by ranking badly in production.
      modelScore: weights ? round(scoreRows(weights, [features])[0]!) : null,
      planCrossLength: plan.crossLength,
      planCandidates: plan.cross.length,
      // What a person is actually shown: each kept cross re-spelled in the frame that reads most
      // comfortably, and the rotation to get there. Renaming moves under a rotation is the part of
      // the planner with the most room for a sign error, and nothing above would notice one.
      plans: plan.cross.map((p) => ({
        text: p.text,
        searchText: serializeMoves(p.searchMoves),
        setup: p.setupText,
        down: p.hold.down,
        front: p.hold.front,
        rotation: p.hold.rotation,
        comfort: round(p.comfort),
      })),
    };
  });
  return { generator: "planner", seed, count, cases };
}

/** The pair search and complete opening planner, recorded separately from the large cross corpus. */
export function s2Vectors(seed: number, count: number): VectorFile {
  const random = seeded(seed);
  const cases = positions(random, count).map((position, i) => {
    const state = fromFacelets(position.facelets);
    // Cycle the colours so even a small, expensive corpus covers all six geometries.
    const face = FACES[i % FACES.length]!;
    const slots = GEOMETRY[face]!.slots;
    const xcross = enumerateAllXcrosses(state, face);
    const plan = planColour(state, face, { keep: 3, lookahead: true });
    const normalised = normalizeOrientation(state);
    const afterCross = applyMoves(normalised, solveCross(state, face) ?? []);
    const nextPair = enumerateNextPair(afterCross, face, { maxNodes: 50_000 });
    const available = xcross.map((result, index) => ({ result, slot: slots[index]! }))
      .filter(({ result }) => result.optimal >= 0);
    const bestLength = Math.min(...available.map(({ result }) => result.optimal));
    const respellInput = parseMoves([
      "L R D U B F", "L2 R2 D2 U2 B2 F2", "L' R' D' U' B' F'",
    ][i % 3]!);
    const record = (solution: (typeof plan.cross)[number]) => ({
      kind: solution.kind,
      slot: solution.slot ?? null,
      searchSlot: solution.searchSlot ?? null,
      slotLabel: solution.slotLabel ?? null,
      text: solution.text,
      searchText: serializeMoves(solution.searchMoves),
      setup: solution.setupText,
      down: solution.hold.down,
      front: solution.hold.front,
      rotation: solution.hold.rotation,
      comfort: round(solution.comfort),
      steps: solution.steps ?? null,
      solvedPairLabels: solution.solvedPairLabels ?? null,
    });
    return {
      facelets: position.facelets,
      face,
      respell: {
        input: serializeMoves(respellInput),
        outputs: respellInput.map((_, index) => {
          const value = respellAsWide(respellInput, index)!;
          return { text: value.text, rotations: value.rotations };
        }),
      },
      pairs: slots.map((slot) => ({ slot: slotName(slot), distance: pairDistance(normalizeOrientation(state), slot) })),
      xcross: xcross.map((result, index) => ({
        slot: slotName(slots[index]!), optimal: result.optimal,
        count: result.candidates.length, truncated: result.stats.truncated,
      })),
      pairRanking: available.map(({ result, slot }) => {
        const features = pairFeatures(normalised, GEOMETRY[face]!, {
          slot, optimal: result.optimal, ways: result.candidates.length,
          bestMoves: result.candidates[0]?.moves ?? [],
        }, { bestLength, previous: null, step: 0, openCount: available.length });
        return {
          slot: slotName(slot), features: features.map(round),
          modelScore: WEIGHTS.pair ? round(scoreRows(WEIGHTS.pair, [features])[0]!) : null,
        };
      }),
      nextPair: nextPair.map(({ slot, result }) => ({
        slot: slotName(slot), optimal: result.optimal,
        count: result.candidates.length, truncated: result.stats.truncated,
      })),
      crossLength: plan.crossLength,
      xcrossLength: plan.xcrossLength,
      cross: plan.cross.map(record),
      keptXcross: plan.xcross.map(record),
      crossPlusOne: plan.crossPlusOne?.map(record) ?? [],
      crossPlusTwo: plan.crossPlusTwo?.map(record) ?? [],
    };
  });
  return { generator: "s2", seed, count, cases };
}

/** Six decimal places: enough to pin a float, few enough that noise does not churn the file. */
const round = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? value : Math.round(value * 1e6) / 1e6;

/** Reconstructions carry `// phase` annotations; the notation parser does not want them. */
const stripComments = (text: string): string =>
  text.replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").trim();

/**
 * Per-move arrival times, in three shapes.
 *
 * 0: steady turning. 1: a slow first second, as a solver reads the cross. 2: one long pause
 * mid-solve, which is what pause detection exists to find.
 */
function synthesiseTimings(random: () => number, moves: number, profile: number): number[] {
  const times: number[] = [];
  let now = 0;
  for (let i = 0; i < moves; i++) {
    let gap = 120 + Math.floor(random() * 80);
    if (profile === 1 && i < 6) gap += 200;
    if (profile === 2 && i === Math.floor(moves / 2)) gap += 1400;
    now += gap;
    times.push(now);
  }
  return times;
}
