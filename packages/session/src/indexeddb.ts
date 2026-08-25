/**
 * IndexedDB-backed store — the local-first half of `PLAN.md`'s storage plan.
 *
 * Browser-only, and imported lazily by the app so server rendering never touches
 * `indexedDB`. `idb` is used rather than the raw API: IndexedDB is event-based with no
 * promises, and wrapping it by hand is a hundred lines of callback plumbing for no gain.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SolveStore } from "./store.ts";
import type { SessionRecord, SolveRecord } from "./types.ts";

const DB_NAME = "cubing-companion";
const DB_VERSION = 1;

interface Schema extends DBSchema {
  sessions: {
    key: string;
    value: SessionRecord;
  };
  solves: {
    key: string;
    value: SolveRecord;
    indexes: {
      /** Solves belonging to one session. */
      "by-session": string;
      /** Ordering, which IndexedDB gives ascending — callers reverse for newest-first. */
      "by-started": number;
    };
  };
}

/**
 * Whether this environment can open a database at all.
 *
 * Reached through `globalThis` rather than the bare global on purpose: the workspace compiles
 * against the Node lib without DOM, and widening that would let the pure packages — engine,
 * analysis — reach for browser APIs by accident. This module is the only one that wants them.
 */
export function isIndexedDbAvailable(): boolean {
  return (
    typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined"
  );
}

export class IndexedDbStore implements SolveStore {
  private database: Promise<IDBPDatabase<Schema>> | null = null;

  private open(): Promise<IDBPDatabase<Schema>> {
    // Opened on first use rather than in the constructor, so merely constructing a store is
    // safe in environments without IndexedDB.
    this.database ??= openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("solves")) {
          const solves = db.createObjectStore("solves", { keyPath: "id" });
          solves.createIndex("by-session", "sessionId");
          solves.createIndex("by-started", "startedAt");
        }
      },
    });
    return this.database;
  }

  async ensureSession(session: SessionRecord): Promise<SessionRecord> {
    const db = await this.open();
    const existing = await db.get("sessions", session.id);
    if (existing) return existing;
    await db.put("sessions", session);
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const db = await this.open();
    const all = await db.getAll("sessions");
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async putSolve(solve: SolveRecord): Promise<void> {
    const db = await this.open();
    await db.put("solves", solve);
  }

  async listSolves(sessionId: string): Promise<SolveRecord[]> {
    const db = await this.open();
    const all = await db.getAllFromIndex("solves", "by-session", sessionId);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async listAllSolves(): Promise<SolveRecord[]> {
    const db = await this.open();
    // The index yields ascending; reversing is cheaper than re-sorting.
    const all = await db.getAllFromIndex("solves", "by-started");
    return all.reverse();
  }

  async deleteSolve(id: string): Promise<void> {
    const db = await this.open();
    await db.delete("solves", id);
  }

  async clear(): Promise<void> {
    const db = await this.open();
    await Promise.all([db.clear("solves"), db.clear("sessions")]);
  }
}
