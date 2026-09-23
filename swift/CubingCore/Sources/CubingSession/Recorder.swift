/// The solve recorder, session statistics and per-phase durations — the Swift counterparts of
/// `recorder.ts`, `stats.ts` and `segmented.ts` in `packages/session`.
///
/// The reasoning behind the recorder's rules — why there is no way back out of `ready`, why the
/// clock starts on the first turn rather than an inspection rotation, why timing faster than any
/// hand is withheld — is in `recorder.ts`, and is not repeated here beyond where it applies.

import CubeLink
import CubingCore
import Foundation

public enum RecorderPhase: String, Sendable {
    case idle, scrambling, ready, solving, complete
}

public struct RecorderState: Sendable {
    public let phase: RecorderPhase
    public let scrambleText: String?
    public let moveCount: Int
    public let elapsedMs: Double?
    public let record: SolveRecord?
}

public final class SolveRecorder {
    /// The world record turn rate is around 15 per second; anything past this was not a person.
    static let maxHumanTps = 50.0

    public let sessionId: String
    public let source: SolveSource
    private let now: () -> Double
    private let makeId: () -> String

    private var phase = RecorderPhase.idle
    private var scrambleText: String?
    private var targetFacelets: String?
    private var startFacelets: String?
    private var scrambleMatched = false
    private var moves: [TimedMove] = []
    private var timeline = MoveTimeline()
    private var startedAt: Double?
    private var finished: SolveRecord?

    public init(
        sessionId: String, source: SolveSource,
        now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
        makeId: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.sessionId = sessionId
        self.source = source
        self.now = now
        self.makeId = makeId
    }

    public var state: RecorderState {
        RecorderState(
            phase: phase, scrambleText: scrambleText,
            moveCount: moves.count - Self.inspectionMoves(moves.map(\.event.move)),
            elapsedMs: elapsedMs, record: finished)
    }

    /// Wait for the cube to reach this scramble, then time the solve that follows.
    public func arm(_ scramble: String, current: CubeState) throws {
        reset()
        scrambleText = scramble
        targetFacelets = Facelets.string(from: CubeState.after(try Notation.parse(scramble)))
        phase = .scrambling
        handleState(current)
    }

    /// Time a solve from wherever the cube is now, without a scramble to match.
    public func startFrom(_ state: CubeState) {
        moves = []
        timeline = MoveTimeline()
        finished = nil
        startFacelets = Facelets.string(from: state)
        scrambleMatched = targetFacelets == startFacelets
        startedAt = nil
        phase = .ready
    }

    public func handleState(_ state: CubeState) {
        let facelets = Facelets.string(from: state)
        if phase == .scrambling {
            if facelets == targetFacelets {
                startFacelets = facelets
                scrambleMatched = true
                phase = .ready
            }
            return
        }
        // No transition back out of `ready`: from state alone, fiddling and the first move of a
        // real solve are the same observation. `discard` is the remedy for a false start.
        if phase == .solving, state.isSolvedIgnoringOrientation { _ = complete(.solved) }
    }

    /// Order matters: the move that solves the cube must reach here before the resulting state.
    public func handleMove(_ move: TimedMove) {
        if phase == .ready {
            phase = .solving
            startedAt = now()
        }
        guard phase == .solving else { return }
        moves.append(move)
        _ = timeline.add(move.event)
    }

    public func discard() -> SolveRecord? {
        guard phase == .solving || phase == .complete else { return nil }
        return complete(.discarded)
    }

    public func reset() {
        phase = .idle
        scrambleText = nil
        targetFacelets = nil
        startFacelets = nil
        scrambleMatched = false
        moves = []
        timeline = MoveTimeline()
        startedAt = nil
        finished = nil
    }

    /// Rotations before the first turn: inspection, which the clock does not charge for.
    static func inspectionMoves(_ moves: [Move]) -> Int {
        moves.firstIndex { !Segmentation.isRotation($0) } ?? moves.count
    }

    private var elapsedMs: Double? {
        if let finished { return finished.durationMs }
        guard phase == .solving else { return nil }
        let timestamps = moves.dropFirst(Self.inspectionMoves(moves.map(\.event.move))).compactMap(\.timestamp)
        guard timestamps.count >= 2 else { return 0 }
        return timestamps.last! - timestamps.first!
    }

    private func complete(_ outcome: SolveOutcome) -> SolveRecord {
        // Retimed over the whole stream now it is finished: live, moves that arrived before the
        // first host timestamp could not be placed; now every move can be fitted.
        let retimed = MoveTimeline.retime(moves.map(\.event))
        let timestamps = retimed.map(\.timestamp)
        let moveList = retimed.map(\.event.move)
        let inspection = Self.inspectionMoves(moveList)
        let known = timestamps.dropFirst(inspection).compactMap { $0 }
        let durationMs = known.count >= 2 ? known.last! - known.first! : nil
        let turns = Double(moveList.filter { !Segmentation.isRotation($0) }.count)

        // Timing no hand produced — a pasted algorithm, a replay — is withheld, together with the
        // per-move timing it came from.
        let plausible = durationMs.map { $0 > 0 && turns / ($0 / 1000) <= Self.maxHumanTps } ?? false
        let reported = plausible ? durationMs : nil

        let record = SolveRecord(
            id: makeId(), sessionId: sessionId, startedAt: startedAt ?? now(),
            startFacelets: startFacelets ?? Facelets.string(from: .solved),
            scrambleText: scrambleText, scrambleMatched: scrambleMatched,
            solution: Notation.write(moveList), moveCount: moveList.count - inspection,
            durationMs: reported, tps: reported.map { turns / ($0 / 1000) },
            source: source, outcome: outcome,
            moveTimestamps: plausible ? timestamps : timestamps.map { _ in nil })
        finished = record
        phase = .complete
        return record
    }
}

// MARK: - Statistics

public struct AverageStat: Equatable, Sendable {
    public let current: Double?
    public let best: Double?
}

public struct SessionStats: Equatable, Sendable {
    public let count: Int
    public let excluded: Int
    public let best: Double?
    public let worst: Double?
    public let mean: Double?
    /// Keyed by size: 5 and 12, as the TypeScript's `AVERAGE_SIZES`.
    public let averages: [Int: AverageStat]
}

public enum Stats {
    public static let averageSizes = [5, 12]

    /// Durations of timed, kept solves, oldest first.
    public static func countable(_ records: [SolveRecord]) -> [Double] {
        records.enumerated()
            .filter { $0.element.outcome != .discarded && $0.element.durationMs != nil }
            // Oldest first, and stably — JavaScript's sort is, and ties keep their order.
            .sorted { ($0.element.startedAt, $0.offset) < ($1.element.startedAt, $1.offset) }
            .map { $0.element.durationMs! }
    }

    /// The WCA trimmed mean: drop the best and worst, average the rest.
    public static func average(_ durations: ArraySlice<Double>, size: Int) -> Double? {
        guard durations.count == size, size >= 3 else { return nil }
        let middle = durations.sorted().dropFirst().dropLast()
        return middle.reduce(0, +) / Double(middle.count)
    }

    public static func session(_ records: [SolveRecord]) -> SessionStats {
        let durations = countable(records)
        var averages: [Int: AverageStat] = [:]
        for size in averageSizes {
            var best: Double?
            if durations.count >= size {
                for end in size...durations.count {
                    if let a = average(durations[(end - size)..<end], size: size), best.map({ a < $0 }) ?? true {
                        best = a
                    }
                }
            }
            averages[size] = AverageStat(current: average(durations.suffix(size), size: size), best: best)
        }
        return SessionStats(
            count: durations.count, excluded: records.count - durations.count,
            best: durations.min(), worst: durations.max(),
            mean: durations.isEmpty ? nil : durations.reduce(0, +) / Double(durations.count),
            averages: averages)
    }
}

// MARK: - Segmentation

public struct SegmentedSolve: Sendable {
    public let record: SolveRecord
    public let segmentation: Segmentation.Result
    public let phaseDurations: [Double?]

    /// Segment a stored solve into CFOP phases from the position it began in.
    public init(_ record: SolveRecord) throws {
        self.record = record
        segmentation = Segmentation.segment(
            from: try Facelets.state(from: record.startFacelets),
            solution: try Notation.parse(record.solution))
        phaseDurations = Metrics.phaseDurations(segmentation.segmentation?.spans ?? [], record.moveTimestamps)
    }
}
