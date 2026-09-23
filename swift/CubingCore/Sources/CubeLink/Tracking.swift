/// Clock fitting and state tracking — the Swift counterparts of `timeline.ts` and `tracker.ts`.
///
/// The cube's own clock is the per-move truth; the host's arrival times carry Bluetooth batching
/// and jitter. `MoveTimeline` least-squares fits one onto the other so every TPS, pause and phase
/// duration is a difference of fitted cube timestamps. See `timeline.ts` for why that insulates
/// the metrics from iOS's longer connection intervals.

import CubingCore

public struct MoveEvent: Sendable {
    public let move: Move
    public let serial: Int
    public let cubeTimestamp: Double?
    public let localTimestamp: Double?

    public init(move: Move, serial: Int, cubeTimestamp: Double?, localTimestamp: Double?) {
        self.move = move
        self.serial = serial
        self.cubeTimestamp = cubeTimestamp
        self.localTimestamp = localTimestamp
    }

    /// From a decoded GAN move: `"R"` or `"R'"`, an outer-face quarter turn and nothing else.
    public init?(_ move: GanMove) {
        guard let family = move.move.first, "URFDLB".contains(family),
            move.move.count == 1 || move.move.dropFirst() == "'"
        else { return nil }
        self.init(
            move: Move(family: String(family), amount: move.move.count == 1 ? 1 : -1),
            serial: move.serial, cubeTimestamp: move.cubeTimestamp,
            localTimestamp: move.localTimestamp)
    }
}

public enum TimestampSource: String, Sendable {
    case fitted
    case cubeOffset = "cube-offset"
    case local
    case interpolated
    case none
}

public struct TimedMove: Sendable {
    public let event: MoveEvent
    public let timestamp: Double?
    public let source: TimestampSource
}

public final class MoveTimeline {
    private struct Anchor { let cube: Double, local: Double }

    private var anchors: [Anchor] = []
    private let windowSize: Int
    private var current: (slope: Double, intercept: Double)?

    public init(windowSize: Int = 64) { self.windowSize = windowSize }

    private static func fit(_ anchors: [Anchor]) -> (slope: Double, intercept: Double)? {
        guard anchors.count >= 2 else { return nil }
        var sumCube = 0.0, sumLocal = 0.0
        for a in anchors {
            sumCube += a.cube
            sumLocal += a.local
        }
        let meanCube = sumCube / Double(anchors.count)
        let meanLocal = sumLocal / Double(anchors.count)
        var covariance = 0.0, variance = 0.0
        for a in anchors {
            let d = a.cube - meanCube
            covariance += d * (a.local - meanLocal)
            variance += d * d
        }
        guard variance != 0 else { return nil }
        let slope = covariance / variance
        return (slope, meanLocal - slope * meanCube)
    }

    /// Place one move, live, against the fit so far.
    public func add(_ event: MoveEvent) -> TimedMove {
        if let cube = event.cubeTimestamp, let local = event.localTimestamp {
            anchors.append(Anchor(cube: cube, local: local))
            if anchors.count > windowSize { anchors.removeFirst() }
            current = Self.fit(anchors)
        }
        if let cube = event.cubeTimestamp, let fit = current {
            return TimedMove(event: event, timestamp: fit.slope * cube + fit.intercept, source: .fitted)
        }
        if let cube = event.cubeTimestamp, let anchor = anchors.last {
            return TimedMove(event: event, timestamp: anchor.local + (cube - anchor.cube), source: .cubeOffset)
        }
        if let local = event.localTimestamp {
            return TimedMove(event: event, timestamp: local, source: .local)
        }
        return TimedMove(event: event, timestamp: nil, source: .none)
    }

    /// How far the cube's clock runs from the host's, in percent.
    public var skewPercent: Double? {
        guard let fit = current, fit.slope != 0 else { return nil }
        return (1 / fit.slope - 1) * 100
    }

    public var anchorCount: Int { anchors.count }

    public func reset() {
        anchors.removeAll()
        current = nil
    }

    /// Place a whole solve after the fact against one fit, then fill gaps between known times.
    public static func retime(_ events: [MoveEvent]) -> [TimedMove] {
        let anchors = events.compactMap { event -> Anchor? in
            guard let cube = event.cubeTimestamp, let local = event.localTimestamp else { return nil }
            return Anchor(cube: cube, local: local)
        }
        let fitted = fit(anchors)
        var moves = events.map { event -> TimedMove in
            if let cube = event.cubeTimestamp, let fit = fitted {
                return TimedMove(event: event, timestamp: fit.slope * cube + fit.intercept, source: .fitted)
            }
            if let cube = event.cubeTimestamp, anchors.count == 1 {
                return TimedMove(event: event, timestamp: anchors[0].local + (cube - anchors[0].cube), source: .cubeOffset)
            }
            if let local = event.localTimestamp {
                return TimedMove(event: event, timestamp: local, source: .local)
            }
            return TimedMove(event: event, timestamp: nil, source: .none)
        }

        // Interpolate runs of unknown times between known neighbours; leave the ends alone.
        var i = 0
        while i < moves.count {
            guard moves[i].timestamp == nil else {
                i += 1
                continue
            }
            var end = i
            while end < moves.count, moves[end].timestamp == nil { end += 1 }
            let before = i > 0 ? moves[i - 1].timestamp : nil
            let after = end < moves.count ? moves[end].timestamp : nil
            if let before, let after {
                let steps = Double(end - i + 1)
                for k in i..<end {
                    moves[k] = TimedMove(
                        event: moves[k].event,
                        timestamp: before + (after - before) * Double(k - i + 1) / steps,
                        source: .interpolated)
                }
            }
            i = end
        }
        return moves
    }
}

// MARK: - Tracker

public struct DesyncEvent: Sendable, Equatable {
    public enum Reason: String, Sendable {
        case serialGap = "serial-gap"
        case stateMismatch = "state-mismatch"
        case initialSync = "initial-sync"
        case setDirectly = "set-directly"
    }
    public let expected: String
    public let actual: String
    public let reason: Reason
}

/// Where a tracker gets the cube's actual state when it needs to check. Main-actor, like the
/// tracker and like the connection that implements it in the app.
@MainActor
public protocol CubeStateSource: AnyObject {
    func queryState() async throws -> CubeState
}

/// Keeps a live `CubeState` in step with a smart cube, and notices when it has not.
///
/// Moves are applied as they arrive. A serial gap means one was missed, so the tracker says so and
/// asks the cube for its real state; any disagreement is resolved by adopting the cube's state,
/// because the cube is right about itself. See `tracker.ts`.
@MainActor
public final class CubeTracker {
    private let source: CubeStateSource
    private let timeline = MoveTimeline()
    private var lastSerial: Int?
    private var verifying = false
    private var pending: Task<Bool, Never>?

    public private(set) var state = CubeState.solved

    public var onMove: ((TimedMove) -> Void)?
    public var onDesync: ((DesyncEvent) -> Void)?
    public var onReseed: ((CubeState) -> Void)?

    public init(source: CubeStateSource) { self.source = source }

    public var skewPercent: Double? { timeline.skewPercent }

    /// Adopt the cube's actual state. Always reports, even when nothing changed.
    public func start() async throws {
        let actual = try await source.queryState()
        adopt(
            actual,
            DesyncEvent(
                expected: Facelets.string(from: state), actual: Facelets.string(from: actual),
                reason: .initialSync))
    }

    public func reseed(_ newState: CubeState) {
        adopt(
            newState,
            DesyncEvent(
                expected: Facelets.string(from: state), actual: Facelets.string(from: newState),
                reason: .setDirectly))
    }

    /// Ask the cube; adopt its state if it disagrees. True when they already agreed.
    @discardableResult
    public func verify() async -> Bool {
        if verifying { return true }
        verifying = true
        defer { verifying = false }
        guard let actual = try? await source.queryState() else { return true }
        let expected = Facelets.string(from: state)
        let actualFacelets = Facelets.string(from: actual)
        if expected == actualFacelets { return true }
        adopt(actual, DesyncEvent(expected: expected, actual: actualFacelets, reason: .stateMismatch))
        return false
    }

    /// Wait for a verification a serial gap started. Tests use it; the app need not.
    public func settle() async { _ = await pending?.value }

    public func handle(_ event: MoveEvent) {
        let previous = lastSerial
        lastSerial = event.serial
        state = state.applying([event.move])
        onMove?(timeline.add(event))

        if let previous, (event.serial - previous + 256) % 256 != 1 {
            onDesync?(
                DesyncEvent(
                    expected: Facelets.string(from: state),
                    actual: "serial \(previous) -> \(event.serial)", reason: .serialGap))
            pending = Task { await self.verify() }
        }
    }

    private func adopt(_ newState: CubeState, _ event: DesyncEvent) {
        state = newState
        timeline.reset()
        lastSerial = nil
        onDesync?(event)
        onReseed?(state)
    }
}
