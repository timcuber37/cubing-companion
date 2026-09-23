/// Solves and sessions as records — the Swift counterpart of `packages/session/src/types.ts`.
///
/// Codable to exactly the JSON the TypeScript writes, field for field, because that JSON is what
/// the Capacitor app left in its SQLite database and what the importer reads. SwiftData stores
/// these through `StoredSolve`; this is the shape they travel in.

public enum SolveSource: String, Codable, Sendable {
    case smartCube = "smart-cube"
    case manual
    case replay

    /// Whether whole-cube rotations can be seen at all. A smart cube reports face turns only, so a
    /// rotation count of zero from one means "not observed", not "none made".
    public var observesRotations: Bool { self != .smartCube }
}

public enum SolveOutcome: String, Codable, Sendable {
    case solved
    case discarded
}

public struct SolveRecord: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var sessionId: String
    /// Milliseconds since 1970, as JavaScript's `Date.now()` gives it.
    public var startedAt: Double

    public var startFacelets: String
    public var scrambleText: String?
    public var scrambleMatched: Bool

    public var solution: String
    /// Moves excluding the inspection rotations before the first turn.
    public var moveCount: Int

    /// Nil when unknown or when the timing could not have come from a hand.
    public var durationMs: Double?
    public var tps: Double?

    public var source: SolveSource
    public var outcome: SolveOutcome

    /// Fitted host time of every move, index-aligned with `solution`; nil where it could not be placed.
    public var moveTimestamps: [Double?]

    public init(
        id: String, sessionId: String, startedAt: Double, startFacelets: String,
        scrambleText: String?, scrambleMatched: Bool, solution: String, moveCount: Int,
        durationMs: Double?, tps: Double?, source: SolveSource, outcome: SolveOutcome,
        moveTimestamps: [Double?]
    ) {
        self.id = id
        self.sessionId = sessionId
        self.startedAt = startedAt
        self.startFacelets = startFacelets
        self.scrambleText = scrambleText
        self.scrambleMatched = scrambleMatched
        self.solution = solution
        self.moveCount = moveCount
        self.durationMs = durationMs
        self.tps = tps
        self.source = source
        self.outcome = outcome
        self.moveTimestamps = moveTimestamps
    }

    // Written out by hand so a nil is encoded as `null`, as `JSON.stringify` writes it, rather than
    // omitted: a record exported from here has every key a TypeScript reader expects.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(startFacelets, forKey: .startFacelets)
        try c.encode(scrambleText, forKey: .scrambleText)
        try c.encode(scrambleMatched, forKey: .scrambleMatched)
        try c.encode(solution, forKey: .solution)
        try c.encode(moveCount, forKey: .moveCount)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(tps, forKey: .tps)
        try c.encode(source, forKey: .source)
        try c.encode(outcome, forKey: .outcome)
        try c.encode(moveTimestamps, forKey: .moveTimestamps)
    }
}

public struct SessionRecord: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var startedAt: Double
    public var label: String

    public init(id: String, startedAt: Double, label: String) {
        self.id = id
        self.startedAt = startedAt
        self.label = label
    }
}
