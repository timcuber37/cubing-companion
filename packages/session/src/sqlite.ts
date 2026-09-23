/**
 * Solve storage in SQLite.
 *
 * The third implementation of {@link SolveStore}, and the one the phone uses. It exists because
 * `IndexedDbStore` is not durable inside a WKWebView: script-writable storage there is subject to
 * eviction under storage pressure, and the treatment of Capacitor's custom scheme has shifted
 * across iOS releases. A year of solve history is not something to leave in a cache.
 *
 * ## The driver seam
 *
 * SQLite itself is reached through {@link SqlDatabase}, a four-method interface, rather than
 * through the Capacitor plugin directly. That is the same trick as `BleTransport` in `cube-link`
 * and it buys the same thing: the **real SQL** — schema, indexes, ordering, parameter binding —
 * runs under `node:sqlite` in CI, so `test/store.test.ts` covers this implementation with the same
 * contract the other two pass. What is left untested is the plugin, which is a bridge and nothing
 * more.
 *
 * ## Why records are stored as JSON
 *
 * One indexed column per queryable field, and the record itself as a JSON blob. `types.ts` is
 * explicit that everything persisted is plain JSON precisely so the stored shape survives the
 * engine's internals changing — column-per-field would give that up, and buy a migration every
 * time a field is added. The columns that exist are the ones queries actually use.
 */
import type { SessionRecord, SolveRecord } from "./types.ts";
import type { SolveStore } from "./store.ts";

/** Values SQLite can bind. Deliberately narrow: everything else becomes JSON first. */
export type SqlValue = string | number | null;

/**
 * The slice of a SQLite driver this needs.
 *
 * Small on purpose — anything that can run a statement and return rows can satisfy it, which is
 * what lets the tests use Node's built-in SQLite and the app use a native one.
 */
export interface SqlDatabase {
  /** Run one or more statements with no parameters and no result. Schema, mostly. */
  execute(sql: string): Promise<void>;
  /** Run a single parameterised statement that returns nothing. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  /** Run a single parameterised query and return its rows. */
  query<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  close?(): Promise<void>;
}

/**
 * Indexed by what the queries order and filter on, and nothing else.
 *
 * `IF NOT EXISTS` throughout because this runs on every open. The indexes mirror the IndexedDB
 * store's `by-session` and `by-started`, so the two implementations have the same performance
 * shape as well as the same behaviour.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  startedAt INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS solves (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS solves_by_session ON solves (sessionId, startedAt DESC);
CREATE INDEX IF NOT EXISTS solves_by_started ON solves (startedAt DESC);
`;

interface JsonRow {
  json: string;
}

export class SqliteSolveStore implements SolveStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SqlDatabase) {}

  /** Created on first use and remembered, so concurrent callers do not race the schema. */
  private open(): Promise<void> {
    this.ready ??= this.db.execute(SCHEMA);
    return this.ready;
  }

  private async rows<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    await this.open();
    const rows = await this.db.query<JsonRow>(sql, params);
    // A driver that returns no rows may return undefined rather than an empty array.
    return (rows ?? []).map((row) => JSON.parse(row.json) as T);
  }

  async ensureSession(session: SessionRecord): Promise<SessionRecord> {
    await this.open();
    const existing = await this.rows<SessionRecord>(
      "SELECT json FROM sessions WHERE id = ?",
      [session.id],
    );
    // "Ensure", not "upsert": an existing session is returned untouched, so re-opening the app
    // cannot overwrite a session's original start time with this one.
    if (existing[0]) return existing[0];

    await this.db.run("INSERT INTO sessions (id, startedAt, json) VALUES (?, ?, ?)", [
      session.id,
      session.startedAt,
      JSON.stringify(session),
    ]);
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.rows<SessionRecord>("SELECT json FROM sessions ORDER BY startedAt DESC");
  }

  async putSolve(solve: SolveRecord): Promise<void> {
    await this.open();
    // Replace rather than insert: the recorder saves a solve and may save it again once it has
    // been segmented or amended, and the id is the same solve either way.
    await this.db.run(
      "INSERT OR REPLACE INTO solves (id, sessionId, startedAt, json) VALUES (?, ?, ?, ?)",
      [solve.id, solve.sessionId, solve.startedAt, JSON.stringify(solve)],
    );
  }

  async listSolves(sessionId: string): Promise<SolveRecord[]> {
    return this.rows<SolveRecord>(
      "SELECT json FROM solves WHERE sessionId = ? ORDER BY startedAt DESC",
      [sessionId],
    );
  }

  async listAllSolves(): Promise<SolveRecord[]> {
    return this.rows<SolveRecord>("SELECT json FROM solves ORDER BY startedAt DESC");
  }

  async deleteSolve(id: string): Promise<void> {
    await this.open();
    await this.db.run("DELETE FROM solves WHERE id = ?", [id]);
  }

  async clear(): Promise<void> {
    await this.open();
    await this.db.run("DELETE FROM solves");
    await this.db.run("DELETE FROM sessions");
  }

  /** Release the underlying connection, where the driver has one to release. */
  async close(): Promise<void> {
    await this.db.close?.();
  }
}
