/**
 * The {@link SqlDatabase} driver for a phone.
 *
 * Its own entry point — `@cubing-companion/session/sqlite` — rather than part of the package
 * barrel, so a web build never pulls the Capacitor plugin into its module graph. Same reasoning as
 * `cube-link`'s `./capacitor` entry, and `test/boundaries.test.ts` enforces it.
 *
 * All this does is translate between the plugin's shapes and the four methods the store needs. It
 * is the one piece of the storage path that CI cannot execute, which is why it is kept this thin:
 * everything that could be wrong about the SQL is wrong in `sqlite.ts`, and that runs under
 * `node:sqlite` in the contract test.
 */
import { SqliteSolveStore, type SqlDatabase, type SqlValue } from "./sqlite.ts";

/** The slice of `@capacitor-community/sqlite` used here, declared so it can be faked. */
export interface CapacitorSqliteConnection {
  open(): Promise<void>;
  execute(statements: string): Promise<unknown>;
  run(statement: string, values?: unknown[]): Promise<unknown>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  close(): Promise<void>;
}

export interface CapacitorSqlitePlugin {
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<CapacitorSqliteConnection>;
  closeConnection(database: string, readonly: boolean): Promise<void>;
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
}

const DATABASE = "cubing-companion";
const VERSION = 1;

/** Wraps a plugin connection as the store's driver. */
export class CapacitorSqlDatabase implements SqlDatabase {
  constructor(
    private readonly connection: CapacitorSqliteConnection,
    private readonly release: () => Promise<void>,
  ) {}

  async execute(sql: string): Promise<void> {
    await this.connection.execute(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.connection.run(sql, [...params]);
  }

  async query<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const result = await this.connection.query(sql, [...params]);
    return (result.values ?? []) as T[];
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => {});
    await this.release();
  }
}

/**
 * Open the app's database and return a store over it.
 *
 * The connection is reused when one is already open: the plugin keeps a registry keyed by database
 * name and rejects a second `createConnection` for the same name, which would otherwise turn a
 * hot reload into a failure to start.
 */
export async function openSqliteStore(
  plugin: CapacitorSqlitePlugin,
): Promise<SqliteSolveStore> {
  const existing = await plugin.isConnection(DATABASE, false).catch(() => ({ result: false }));
  if (existing.result === true) await plugin.closeConnection(DATABASE, false).catch(() => {});

  const connection = await plugin.createConnection(DATABASE, false, "no-encryption", VERSION, false);
  await connection.open();

  return new SqliteSolveStore(
    new CapacitorSqlDatabase(connection, () =>
      plugin.closeConnection(DATABASE, false).catch(() => {}),
    ),
  );
}

/**
 * The store for this device, wired to the real plugin.
 *
 * Imported dynamically so that merely importing this module does not require Capacitor.
 */
export async function capacitorSolveStore(): Promise<SqliteSolveStore> {
  const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
  const plugin = new SQLiteConnection(CapacitorSQLite) as unknown as CapacitorSqlitePlugin;
  return openSqliteStore(plugin);
}
