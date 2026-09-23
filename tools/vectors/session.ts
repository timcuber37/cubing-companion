/**
 * Recording and history, for S4 of `SWIFT_PLAN.md`: the solve recorder, session statistics,
 * per-phase durations, and the Capacitor app's SQLite database as the native app will find it.
 *
 * Three kinds of case:
 *
 * - `recorder` — a scripted person at the cube: arm a scramble, turn it in (sometimes making a
 *   mistake and undoing it), solve — with inspection rotations, wasted moves, recovered moves that
 *   carry no clock, false starts that get discarded, and timing no hand could produce. After every
 *   step, everything the recorder reports; for every finished solve, its segmentation and per-phase
 *   durations, which is what the history screen shows.
 * - `stats` — best, worst, mean and the trimmed averages over arbitrary lists of solves.
 * - `sqlite` — every solve the recorder cases produced, as written by the TypeScript
 *   `SqliteSolveStore` into `vectors/capacitor-solves.sqlite`: the same schema and the same JSON the
 *   Capacitor app writes, so the native importer is tested against the real thing rather than
 *   against its own idea of it.
 */
import { DatabaseSync } from "node:sqlite";
import { applyMoves, CubeState, invertMove, makeMove, serializeMoves, toFacelets, type Move } from "@cubing-companion/engine";
import { randomMoveScramble } from "@cubing-companion/engine/scramble";
import { MoveTimeline } from "@cubing-companion/cube-link";
import { segmentRecord, sessionStats, SolveRecorder, type SolveRecord, type SolveSource } from "@cubing-companion/session";
import { SqliteSolveStore, type SqlDatabase, type SqlValue } from "../../packages/session/src/sqlite.ts";
import { integer, pick, seeded } from "./random.ts";
import type { VectorFile } from "./cases.ts";

const notation = (move: Move) => serializeMoves([move]);

/** What the history screen needs from a finished solve. */
function segmented(record: SolveRecord) {
  const { segmentation, phaseDurations } = segmentRecord(record);
  return {
    failure: segmentation.failure,
    crossFace: segmentation.segmentation?.crossFace ?? null,
    phases: segmentation.segmentation?.spans.map((s) => ({ phase: s.phase, start: s.start, end: s.end })) ?? null,
    phaseDurations,
  };
}

type Timing = "human" | "blistering" | "instant" | "recovered";

const ROTATION_PAIRS: readonly [string, string][] = [["y", "y'"], ["x2", "x2"], ["z'", "z"], ["y2", "y2"], ["x", "x'"]];

function recorderCase(random: () => number, index: number) {
  const source: SolveSource = random() < 0.7 ? "smart-cube" : "manual";
  const sessionId = `session-${index}`;
  let clock = 1_758_000_000_000 + integer(random, 0, 1_000_000_000);
  let ids = 0;
  const recorder = new SolveRecorder({
    sessionId, source, now: () => clock, makeId: () => `${sessionId}-solve-${++ids}`,
  });
  // The tracker's live timeline, as the app runs it: the recorder is fed its placements.
  const timeline = new MoveTimeline();
  let serial = integer(random, 0, 255);
  let cube = integer(random, 0, 1_000_000);
  // Host clock in the tracker's own units — milliseconds since the app started, not wall time.
  let host = integer(random, 1000, 100_000);

  // Every move applied since solved, so any position can be undone.
  let history: Move[] = [];
  let state = CubeState.solved();
  const records: SolveRecord[] = [];
  const steps: unknown[] = [];

  const snapshot = () => {
    const s = recorder.getState();
    // The finished record itself is recorded once, in `completed`, at the step that finished it.
    return { phase: s.phase, scrambleText: s.scrambleText, moveCount: s.moveCount, elapsedMs: s.elapsedMs, hasRecord: s.record !== null };
  };
  const finished = (record: SolveRecord | null) => {
    if (!record) return null;
    records.push(record);
    return { record, ...segmented(record) };
  };

  const turn = (move: Move, timing: Timing) => {
    if (timing !== "instant") {
      // "blistering" straddles the 50-per-second ceiling on plausible timing, so the ceiling itself
      // is pinned: human timing is far below it and instant timing far above.
      const gap = timing === "blistering" ? integer(random, 15, 45) : integer(random, 60, 350);
      clock += gap;
      host += gap;
      cube += gap + integer(random, -4, 4);
    }
    serial = (serial + 1) & 0xff;
    const recovered = timing === "recovered";
    const event = {
      move, serial,
      cubeTimestamp: recovered ? null : cube,
      localTimestamp: recovered ? null : host + integer(random, 0, 30),
    };
    const timed = timeline.add(event);
    state = applyMoves(state, [move]);
    history.push(move);
    const before = recorder.getState().phase;
    recorder.handleMove(timed);
    recorder.handleState(state);
    const after = recorder.getState();
    // The cube's position and the timeline's placement are left for the port to derive: both come
    // from code already checked against its own corpus (`engine`, `cubelink`), and recording them
    // on every move tripled the size of this file.
    steps.push({
      op: "move", move: notation(move), serial, cubeTimestamp: event.cubeTimestamp,
      localTimestamp: event.localTimestamp, now: clock, output: snapshot(),
      completed: before !== "complete" && after.phase === "complete" ? finished(after.record) : null,
    });
  };

  // Half the cases begin part-way through a solve rather than from solved.
  if (random() < 0.5) {
    const moves = randomMoveScramble(integer(random, 6, 20), random);
    state = applyMoves(state, moves);
    history = [...moves];
    steps.push({ op: "state", facelets: toFacelets(state), now: clock, output: snapshot() });
    recorder.handleState(state);
  }

  for (let attempt = 0, attempts = integer(random, 1, 3); attempt < attempts; attempt++) {
    clock += integer(random, 2000, 20_000);
    host += integer(random, 2000, 20_000);
    const solvedNow = toFacelets(state) === toFacelets(CubeState.solved());

    if (solvedNow || random() < 0.3) {
      const scramble = randomMoveScramble(integer(random, 15, 25), random);
      const text = serializeMoves(scramble);
      recorder.arm(text, state);
      steps.push({ op: "arm", scramble: text, facelets: toFacelets(state), now: clock, output: snapshot() });
      if (!solvedNow) {
        // Armed on an unsolved cube: the scramble cannot be reached by turning it in, so practise
        // from here instead — the "start from here" path.
        recorder.startFrom(state);
        steps.push({ op: "startFrom", facelets: toFacelets(state), now: clock, output: snapshot() });
      } else {
        for (const [i, move] of scramble.entries()) {
          turn(move, "human");
          // A slip, undone: the recorder must still arm when the scramble is finally matched.
          if (i === 3 && random() < 0.3) {
            const slip = makeMove(pick(random, ["U", "R", "F", "D", "L", "B"]), 1)!;
            turn(slip, "human");
            turn(invertMove(slip), "human");
          }
        }
      }
    } else {
      recorder.startFrom(state);
      steps.push({ op: "startFrom", facelets: toFacelets(state), now: clock, output: snapshot() });
    }

    const roll = random();
    const timing: Timing = roll < 0.1 ? "instant" : roll < 0.25 ? "blistering" : "human";
    // Inspection rotations, only where a rotation can be observed at all.
    if (source === "manual" && random() < 0.5) {
      const [a, b] = pick(random, ROTATION_PAIRS);
      turn(makeMove(a.replace(/['2]/, ""), a.endsWith("2") ? 2 : a.endsWith("'") ? -1 : 1)!, timing);
      turn(makeMove(b.replace(/['2]/, ""), b.endsWith("2") ? 2 : b.endsWith("'") ? -1 : 1)!, timing);
    }

    const solution = [...history].reverse().map(invertMove);
    const discardAt = random() < 0.15 ? integer(random, 1, Math.max(1, solution.length - 1)) : -1;
    const recoverFrom = random() < 0.2 ? integer(random, 0, solution.length) : -1;
    for (const [i, move] of solution.entries()) {
      if (i === discardAt) {
        clock += integer(random, 300, 3000);
        const record = recorder.discard();
        steps.push({ op: "discard", now: clock, output: snapshot(), completed: finished(record) });
        break;
      }
      // Wasted moves, turned and undone, so the solution is not simply the inverse scramble.
      if (i === 2 && random() < 0.3) {
        const waste = makeMove(pick(random, ["U", "R", "F"]), 1)!;
        turn(waste, timing);
        turn(invertMove(waste), timing);
      }
      turn(move, recoverFrom >= 0 && i >= recoverFrom && i < recoverFrom + 2 ? "recovered" : timing);
    }
    history = toFacelets(state) === toFacelets(CubeState.solved()) ? [] : history;
    // Sometimes the person walks away and the recorder is reset.
    if (random() < 0.1) {
      recorder.reset();
      steps.push({ op: "reset", now: clock, output: snapshot() });
    }
  }

  return { kind: "recorder", source, sessionId, steps, records };
}

function statsCase(random: () => number) {
  const records = Array.from({ length: integer(random, 0, 40) }, (_, i) => ({
    startedAt: integer(random, 0, 1_000_000),
    durationMs: random() < 0.1 ? null : integer(random, 6000, 40_000) + random(),
    outcome: random() < 0.1 ? "discarded" : "solved",
    i,
  }));
  const stats = sessionStats(records as unknown as SolveRecord[]);
  return {
    kind: "stats",
    records: records.map(({ startedAt, durationMs, outcome }) => ({ startedAt, durationMs, outcome })),
    stats: { ...stats, averages: { 5: stats.averages[5], 12: stats.averages[12] } },
  };
}

export async function sessionVectors(seed: number, count: number): Promise<VectorFile> {
  const random = seeded(seed);
  const recorders = Array.from({ length: count }, (_, i) => recorderCase(random, i));
  const stats = Array.from({ length: 100 }, () => statsCase(random));

  // The records as a SQLite store would hand them back: newest first, JSON round-tripped.
  const solves = recorders.flatMap((c) => c.records).sort((a, b) => b.startedAt - a.startedAt);
  const sessions = recorders
    .map((c) => ({ id: c.sessionId, startedAt: c.records[0]?.startedAt ?? 0, label: `Session ${c.sessionId}` }))
    .filter((s) => s.startedAt > 0)
    .sort((a, b) => b.startedAt - a.startedAt);

  return {
    generator: "session",
    seed,
    count,
    cases: [
      ...recorders.map(({ records: _records, ...rest }) => rest),
      ...stats,
      { kind: "sqlite", file: "vectors/capacitor-solves.sqlite", sessions, solves },
    ],
  };
}

/** `node:sqlite` as the store's driver, as `packages/session/test/store.test.ts` does. */
function nodeSqlite(file: string): SqlDatabase {
  const db = new DatabaseSync(file);
  return {
    execute: async (sql) => void db.exec(sql),
    run: async (sql, params: readonly SqlValue[] = []) => void db.prepare(sql).run(...params),
    query: async <T>(sql: string, params: readonly SqlValue[] = []) => db.prepare(sql).all(...params) as T[],
    close: async () => db.close(),
  };
}

/**
 * Write the `sqlite` case's solves through the real TypeScript store, so the file is exactly what
 * the Capacitor app would have left in its container.
 */
export async function writeCapacitorFixture(file: string, vectors: VectorFile): Promise<number> {
  const fixture = vectors.cases.find((c) => (c as { kind: string }).kind === "sqlite") as {
    sessions: { id: string; startedAt: number; label: string }[];
    solves: SolveRecord[];
  };
  const store = new SqliteSolveStore(nodeSqlite(file));
  await store.clear();
  for (const session of fixture.sessions) await store.ensureSession(session);
  for (const solve of fixture.solves) await store.putSolve(solve);
  await store.close();
  return fixture.solves.length;
}
