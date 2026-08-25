/**
 * Persistence for solves and sessions.
 *
 * The interface exists so the IndexedDB implementation is not the only one. `MemoryStore`
 * backs the tests and server rendering, and `PLAN.md`'s "sync later (Turso/Postgres)" becomes
 * another implementation rather than a rewrite. A shared contract test keeps them honest.
 */
import type { SessionRecord, SolveRecord } from "./types.ts";

export interface SolveStore {
  /** Create a session, or return the existing one with this id. */
  ensureSession(session: SessionRecord): Promise<SessionRecord>;
  listSessions(): Promise<SessionRecord[]>;

  putSolve(solve: SolveRecord): Promise<void>;
  /** Solves in a session, newest first. */
  listSolves(sessionId: string): Promise<SolveRecord[]>;
  deleteSolve(id: string): Promise<void>;
  /** Every solve across every session, newest first. */
  listAllSolves(): Promise<SolveRecord[]>;

  clear(): Promise<void>;
}

const newestFirst = (a: SolveRecord, b: SolveRecord) => b.startedAt - a.startedAt;

/**
 * In-memory store.
 *
 * Used by tests, and as the fallback wherever IndexedDB is unavailable — server rendering, or
 * a browser in private mode that refuses to open a database. Falling back to this keeps the
 * app usable rather than failing to load; solves are simply lost on reload, which the UI says.
 */
export class MemoryStore implements SolveStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly solves = new Map<string, SolveRecord>();

  async ensureSession(session: SessionRecord): Promise<SessionRecord> {
    const existing = this.sessions.get(session.id);
    if (existing) return existing;
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async putSolve(solve: SolveRecord): Promise<void> {
    this.solves.set(solve.id, solve);
  }

  async listSolves(sessionId: string): Promise<SolveRecord[]> {
    return [...this.solves.values()]
      .filter((s) => s.sessionId === sessionId)
      .sort(newestFirst);
  }

  async listAllSolves(): Promise<SolveRecord[]> {
    return [...this.solves.values()].sort(newestFirst);
  }

  async deleteSolve(id: string): Promise<void> {
    this.solves.delete(id);
  }

  async clear(): Promise<void> {
    this.sessions.clear();
    this.solves.clear();
  }
}
