/// Solve history in SwiftData — the native replacement for `SolveStore` and its three TypeScript
/// implementations.
///
/// Records keep their TypeScript identity: a solve's `id` is the one the recorder gave it, so a solve
/// imported from the Capacitor app and the same solve imported again are one row, not two. The
/// fields are real model properties, so SwiftUI can query and sort them, with two exceptions noted
/// where they occur.

import Foundation
import SwiftData

@Model
public final class StoredSession {
    @Attribute(.unique) public var id: String
    public var startedAt: Double
    public var label: String

    public init(_ record: SessionRecord) {
        id = record.id
        startedAt = record.startedAt
        label = record.label
    }

    public var record: SessionRecord { SessionRecord(id: id, startedAt: startedAt, label: label) }
}

@Model
public final class StoredSolve {
    @Attribute(.unique) public var id: String
    public var sessionId: String
    public var startedAt: Double
    public var startFacelets: String
    public var scrambleText: String?
    public var scrambleMatched: Bool
    public var solution: String
    public var moveCount: Int
    public var durationMs: Double?
    public var tps: Double?
    /// Raw values rather than the enums, so predicates can filter on them.
    public var source: String
    public var outcome: String
    /// `[Double?]` as JSON. SwiftData's handling of arrays of optionals has been unreliable, and
    /// nothing queries inside this; it is read whole, to time the phases of one solve.
    public var moveTimestamps: Data

    public init(_ record: SolveRecord) {
        id = record.id
        sessionId = record.sessionId
        startedAt = record.startedAt
        startFacelets = record.startFacelets
        scrambleText = record.scrambleText
        scrambleMatched = record.scrambleMatched
        solution = record.solution
        moveCount = record.moveCount
        durationMs = record.durationMs
        tps = record.tps
        source = record.source.rawValue
        outcome = record.outcome.rawValue
        moveTimestamps = (try? JSONEncoder().encode(record.moveTimestamps)) ?? Data("[]".utf8)
    }

    func update(from record: SolveRecord) {
        let fresh = StoredSolve(record)
        sessionId = fresh.sessionId
        startedAt = fresh.startedAt
        startFacelets = fresh.startFacelets
        scrambleText = fresh.scrambleText
        scrambleMatched = fresh.scrambleMatched
        solution = fresh.solution
        moveCount = fresh.moveCount
        durationMs = fresh.durationMs
        tps = fresh.tps
        source = fresh.source
        outcome = fresh.outcome
        moveTimestamps = fresh.moveTimestamps
    }

    public var record: SolveRecord {
        SolveRecord(
            id: id, sessionId: sessionId, startedAt: startedAt, startFacelets: startFacelets,
            scrambleText: scrambleText, scrambleMatched: scrambleMatched, solution: solution,
            moveCount: moveCount, durationMs: durationMs, tps: tps,
            source: SolveSource(rawValue: source) ?? .manual,
            outcome: SolveOutcome(rawValue: outcome) ?? .solved,
            moveTimestamps: (try? JSONDecoder().decode([Double?].self, from: moveTimestamps)) ?? [])
    }
}

@MainActor
public final class SolveLibrary {
    /// Held, not just its context: a `ModelContext` does not keep its container alive, and using one
    /// whose container has gone traps.
    public let container: ModelContainer
    public let context: ModelContext

    public static let schema = Schema([StoredSession.self, StoredSolve.self])

    /// The app's store on disk, or an in-memory one for tests and previews.
    public static func container(inMemory: Bool = false) throws -> ModelContainer {
        try ModelContainer(
            for: schema, configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory)])
    }

    public init(_ container: ModelContainer) {
        self.container = container
        context = container.mainContext
    }

    // MARK: Sessions

    /// "Ensure", not "upsert": an existing session is returned untouched, as the TypeScript does, so
    /// reopening the app cannot overwrite a session's original start time.
    @discardableResult
    public func ensureSession(_ session: SessionRecord) throws -> SessionRecord {
        let id = session.id
        if let existing = try context.fetch(FetchDescriptor(predicate: #Predicate<StoredSession> { $0.id == id })).first {
            return existing.record
        }
        context.insert(StoredSession(session))
        try context.save()
        return session
    }

    public func sessions() throws -> [SessionRecord] {
        try context.fetch(FetchDescriptor<StoredSession>(sortBy: [SortDescriptor(\.startedAt, order: .reverse)]))
            .map(\.record)
    }

    // MARK: Solves

    /// Insert, or replace the solve with the same id.
    public func put(_ solve: SolveRecord) throws {
        try upsert(solve)
        try context.save()
    }

    public func solves(in sessionId: String) throws -> [SolveRecord] {
        try context.fetch(
            FetchDescriptor(
                predicate: #Predicate<StoredSolve> { $0.sessionId == sessionId },
                sortBy: [SortDescriptor(\.startedAt, order: .reverse)])
        ).map(\.record)
    }

    public func allSolves() throws -> [SolveRecord] {
        try context.fetch(FetchDescriptor<StoredSolve>(sortBy: [SortDescriptor(\.startedAt, order: .reverse)]))
            .map(\.record)
    }

    public func delete(_ id: String) throws {
        try context.delete(model: StoredSolve.self, where: #Predicate { $0.id == id })
        try context.save()
    }

    @discardableResult
    private func upsert(_ solve: SolveRecord) throws -> Bool {
        let id = solve.id
        if let existing = try context.fetch(FetchDescriptor(predicate: #Predicate<StoredSolve> { $0.id == id })).first {
            existing.update(from: solve)
            return false
        }
        context.insert(StoredSolve(solve))
        return true
    }

    // MARK: Import

    public struct ImportSummary: Sendable, Equatable {
        public let sessions: Int
        public let added: Int
        public let alreadyPresent: Int
        public let unreadable: Int
    }

    /// Bring in the Capacitor app's history. Idempotent: a solve already here by id is refreshed,
    /// not duplicated, so running this twice — or after a partial run — is harmless.
    public func importCapacitor(from url: URL = CapacitorImport.defaultLocation) throws -> ImportSummary {
        let contents = try CapacitorImport.read(url)
        for session in contents.sessions { try ensureSession(session) }
        var added = 0
        for solve in contents.solves where try upsert(solve) { added += 1 }
        try context.save()
        return ImportSummary(
            sessions: contents.sessions.count, added: added,
            alreadyPresent: contents.solves.count - added, unreadable: contents.unreadable)
    }
}
