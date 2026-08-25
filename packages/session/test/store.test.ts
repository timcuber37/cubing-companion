/**
 * Store tests.
 *
 * Both implementations run the same contract. That is the point: `MemoryStore` backs tests and
 * server rendering while `IndexedDbStore` backs the browser, and if they diverge the bug
 * surfaces only in production, on a machine that isn't running the tests.
 *
 * IndexedDB is exercised through `fake-indexeddb`, which is a real implementation of the spec
 * rather than a mock — so the schema, indexes and transactions are genuinely tested.
 */
import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { MemoryStore, type SolveStore } from "../src/store.ts";
import { IndexedDbStore } from "../src/indexeddb.ts";
import type { SessionRecord, SolveRecord } from "../src/types.ts";

const session = (id: string, startedAt = 1000): SessionRecord => ({
  id,
  startedAt,
  label: `session ${id}`,
});

const solve = (
  id: string,
  sessionId: string,
  startedAt: number,
): SolveRecord => ({
  id,
  sessionId,
  startedAt,
  startFacelets: "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB",
  scrambleText: "R U R'",
  scrambleMatched: true,
  solution: "R U' R'",
  moveCount: 3,
  durationMs: 1500,
  tps: 2,
  source: "manual",
  outcome: "solved",
  moveTimestamps: [0, 500, 1500],
});

const implementations: [string, () => SolveStore][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["IndexedDbStore", () => new IndexedDbStore()],
];

for (const [name, make] of implementations) {
  describe(`${name} contract`, () => {
    let store: SolveStore;

    beforeEach(async () => {
      store = make();
      await store.clear();
    });

    it("starts empty", async () => {
      expect(await store.listAllSolves()).toEqual([]);
      expect(await store.listSessions()).toEqual([]);
    });

    it("stores and returns a solve", async () => {
      await store.ensureSession(session("s1"));
      const record = solve("a", "s1", 100);
      await store.putSolve(record);
      expect(await store.listSolves("s1")).toEqual([record]);
    });

    it("returns solves newest first", async () => {
      await store.ensureSession(session("s1"));
      await store.putSolve(solve("old", "s1", 100));
      await store.putSolve(solve("new", "s1", 300));
      await store.putSolve(solve("middle", "s1", 200));
      expect((await store.listSolves("s1")).map((s) => s.id)).toEqual([
        "new",
        "middle",
        "old",
      ]);
      expect((await store.listAllSolves()).map((s) => s.id)).toEqual([
        "new",
        "middle",
        "old",
      ]);
    });

    it("keeps sessions separate", async () => {
      await store.ensureSession(session("s1"));
      await store.ensureSession(session("s2"));
      await store.putSolve(solve("a", "s1", 100));
      await store.putSolve(solve("b", "s2", 200));

      expect((await store.listSolves("s1")).map((s) => s.id)).toEqual(["a"]);
      expect((await store.listSolves("s2")).map((s) => s.id)).toEqual(["b"]);
      expect(await store.listAllSolves()).toHaveLength(2);
    });

    it("does not duplicate an existing session", async () => {
      const first = await store.ensureSession(session("s1", 1000));
      const second = await store.ensureSession(session("s1", 9999));
      // The original wins: re-opening the app must not restamp an ongoing session.
      expect(second).toEqual(first);
      expect(await store.listSessions()).toHaveLength(1);
    });

    it("overwrites a solve with the same id", async () => {
      await store.ensureSession(session("s1"));
      await store.putSolve(solve("a", "s1", 100));
      await store.putSolve({ ...solve("a", "s1", 100), moveCount: 42 });
      const all = await store.listSolves("s1");
      expect(all).toHaveLength(1);
      expect(all[0]!.moveCount).toBe(42);
    });

    it("deletes a solve", async () => {
      await store.ensureSession(session("s1"));
      await store.putSolve(solve("a", "s1", 100));
      await store.putSolve(solve("b", "s1", 200));
      await store.deleteSolve("a");
      expect((await store.listSolves("s1")).map((s) => s.id)).toEqual(["b"]);
    });

    it("ignores deleting something that is not there", async () => {
      await expect(store.deleteSolve("nope")).resolves.toBeUndefined();
    });

    it("returns nothing for an unknown session", async () => {
      expect(await store.listSolves("missing")).toEqual([]);
    });

    it("round-trips a record unchanged", async () => {
      await store.ensureSession(session("s1"));
      const record = solve("a", "s1", 100);
      await store.putSolve(record);
      const [loaded] = await store.listSolves("s1");
      expect(loaded).toEqual(record);
    });

    it("clears everything", async () => {
      await store.ensureSession(session("s1"));
      await store.putSolve(solve("a", "s1", 100));
      await store.clear();
      expect(await store.listAllSolves()).toEqual([]);
      expect(await store.listSessions()).toEqual([]);
    });
  });
}

describe("IndexedDB availability", () => {
  it("detects the environment", async () => {
    // `fake-indexeddb/auto` installs the global, so this is true here and in a browser, and
    // false under plain Node or during server rendering.
    const { isIndexedDbAvailable } = await import("../src/indexeddb.ts");
    expect(isIndexedDbAvailable()).toBe(true);
  });
});
