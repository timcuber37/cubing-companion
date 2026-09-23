/// Reading the Capacitor app's solve history.
///
/// The plan (SWIFT_PLAN.md, S4) is to inherit it at the cutover: the native app takes over the
/// Capacitor app's bundle identifier, iOS keeps the container, and the database the Capacitor SQLite
/// plugin wrote is still there. The plugin keeps it at `Documents/<name>SQLite.db`, and the
/// TypeScript store names it `cubing-companion`; the schema is `packages/session/src/sqlite.ts` —
/// each record a JSON document in a row, with its id, session and start time alongside for indexing.
///
/// Read-only, through the system's SQLite, so the source is never modified: importing twice, or
/// importing and then rolling the cutover back, costs nothing.

import Foundation
import SQLite3

public enum CapacitorImport {
    /// Where the Capacitor app's database sits, relative to the app's container.
    public static let databaseName = "cubing-companionSQLite.db"

    public static var defaultLocation: URL {
        URL.documentsDirectory.appendingPathComponent(databaseName)
    }

    public struct Contents: Sendable {
        public let sessions: [SessionRecord]
        public let solves: [SolveRecord]
        /// Rows that were present but would not decode — reported, not silently lost.
        public let unreadable: Int
    }

    public struct ImportError: Error, CustomStringConvertible {
        public let description: String
    }

    /// Read every session and solve, newest first, as the TypeScript store lists them.
    public static func read(_ url: URL) throws -> Contents {
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            let reason = db.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open"
            sqlite3_close(db)
            throw ImportError(description: "\(url.lastPathComponent): \(reason)")
        }
        defer { sqlite3_close(db) }

        func documents(_ sql: String) throws -> [Data] {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
                throw ImportError(description: String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(statement) }
            var rows: [Data] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                guard let text = sqlite3_column_text(statement, 0) else { continue }
                rows.append(Data(String(cString: text).utf8))
            }
            return rows
        }

        let decoder = JSONDecoder()
        var unreadable = 0
        func decode<T: Decodable>(_ rows: [Data]) -> [T] {
            rows.compactMap { row in
                if let value = try? decoder.decode(T.self, from: row) { return value }
                unreadable += 1
                return nil
            }
        }
        let sessions: [SessionRecord] = decode(try documents("SELECT json FROM sessions ORDER BY startedAt DESC"))
        let solves: [SolveRecord] = decode(try documents("SELECT json FROM solves ORDER BY startedAt DESC"))
        return Contents(sessions: sessions, solves: solves, unreadable: unreadable)
    }
}
