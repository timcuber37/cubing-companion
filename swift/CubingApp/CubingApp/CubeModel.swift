import CubeLink
import CubingCore
import Observation
import SwiftUI

/// The connected cube, as the UI sees it: link state, the tracked cube state, and recent moves.
///
/// Owns the connection and the tracker and wires one to the other, which is all `GanCubeSource`
/// and `CubeHarness` did between them in the web app. Everything here is on the main actor, as
/// CoreBluetooth delivers there.
@MainActor
@Observable
final class CubeModel {
    struct LoggedMove: Identifiable {
        let id: Int
        let notation: String
        let serial: Int
        /// Milliseconds since the previous move, from the fitted timeline when there is one.
        let gapMs: Double?
        let source: TimestampSource
        /// How long the driver's buffer held the move waiting for an earlier one. Nil if recovered.
        let heldMs: Double?
        /// Resent by the cube on request, having been lost the first time.
        var recovered: Bool { heldMs == nil }
    }

    private(set) var link = LinkState.idle
    private(set) var discovered: [DiscoveredCube] = []
    private(set) var facelets = Facelets.string(from: .solved)
    /// The move that produced `facelets`, for the renderer to animate. Nil after a reseed.
    private(set) var lastMove: Move?
    /// Changes on every state change, so a repeated identical move still animates.
    private(set) var revision = 0
    private(set) var moves: [LoggedMove] = []
    private(set) var battery: Int?
    private(set) var hardware: GanHardware?
    private(set) var desyncs = 0
    private(set) var lastDesync: String?
    private(set) var skewPercent: Double?
    private(set) var stats = LinkStats()
    private(set) var recoveredMoves = 0
    private(set) var longestHoldMs = 0.0
    private(set) var isRecording = false
    private(set) var recording: URL?
    /// Held time of the move being handed to the tracker, which reports it back synchronously.
    private var releasing: Double?

    let connection = GanCubeConnection()
    private let tracker: CubeTracker
    private var lastTimestamp: Double?
    private var moveCount = 0
    /// Set when a connection drops without being asked to, so coming back to the app reconnects.
    private(set) var dropped = false
    private var disconnecting = false

    var hasRememberedCube: Bool { connection.lastCube != nil }

    /// Whether this cube's key can be derived: its address was advertised or remembered.
    func knowsAddress(of cube: DiscoveredCube) -> Bool {
        cube.mac != nil || connection.macStore.mac(for: cube.id) != nil
    }

    var isConnected: Bool {
        if case .connected = link { true } else { false }
    }

    init() {
        tracker = CubeTracker(source: connection)
        connection.onStateChange = { [weak self] state in self?.linkChanged(state) }
        connection.onDiscovered = { [weak self] cubes in self?.discovered = cubes }
        connection.onEvent = { [weak self] event in self?.handle(event) }

        tracker.onMove = { [weak self] timed in self?.moved(timed) }
        tracker.onReseed = { [weak self] state in
            guard let self else { return }
            facelets = Facelets.string(from: state)
            lastMove = nil
            revision += 1
        }
        tracker.onDesync = { [weak self] event in
            guard let self, event.reason != .initialSync else { return }
            desyncs += 1
            lastDesync = "\(event.reason.rawValue): \(event.actual)"
        }
    }

    // MARK: Actions

    func scan() { connection.startScan() }
    func stopScan() { connection.stopScan() }
    func connect(_ cube: DiscoveredCube) { connection.connect(cube.id) }
    func reconnect() { connection.reconnect() }

    func disconnect() {
        disconnecting = true
        connection.disconnect()
    }

    /// Check the mirror against the cube, and adopt the cube's state if they disagree.
    func sync() { Task { await tracker.verify() } }

    /// The cube is solved in your hands: tell its firmware, and the mirror.
    func markSolved() {
        connection.send(.requestReset)
        tracker.reseed(.solved)
    }

    func toggleRecording() {
        if connection.isRecording {
            recording = connection.stopRecording()
        } else {
            connection.startRecording()
        }
        isRecording = connection.isRecording
    }

    /// Coming back to the foreground. iOS drops Bluetooth within seconds of backgrounding.
    func resumed() {
        if dropped, !isConnected { connection.reconnect() }
    }

    // MARK: Events

    private func linkChanged(_ state: LinkState) {
        let wasConnected = isConnected
        link = state
        switch state {
        case .connected:
            dropped = false
            UIApplication.shared.isIdleTimerDisabled = true
            Task {
                // Adopt the cube's actual state first: Gen4 ignores moves until a facelet report
                // has set its serial, and the mirror must start from the truth, not from solved.
                try? await tracker.start()
                connection.send(.requestHardware)
                connection.send(.requestBattery)
            }
        case .idle, .failed:
            UIApplication.shared.isIdleTimerDisabled = false
            // Only a drop nobody asked for is worth reconnecting after.
            if wasConnected { dropped = !disconnecting }
            disconnecting = false
            // A disconnect ends a recording; keep it, since a drop is when it is most wanted.
            isRecording = false
            recording = connection.lastRecording ?? recording
        default:
            break
        }
    }

    private func handle(_ event: GanEvent) {
        switch event {
        case .move(let move):
            // Released now, arrived at `localTimestamp`: the difference is time spent in the buffer.
            releasing = move.localTimestamp.map { GanCubeConnection.now() - $0 }
            if let held = releasing { longestHoldMs = max(longestHoldMs, held) } else { recoveredMoves += 1 }
            if let event = MoveEvent(move) { tracker.handle(event) }
        case .battery(_, let level):
            battery = level
        case .hardware(let info):
            hardware = info
        default:
            break
        }
        stats = connection.stats
    }

    private func moved(_ timed: TimedMove) {
        facelets = Facelets.string(from: tracker.state)
        lastMove = timed.event.move
        revision += 1
        skewPercent = tracker.skewPercent

        let gap = zip(timed.timestamp, lastTimestamp).map { $0 - $1 }
        if let timestamp = timed.timestamp { lastTimestamp = timestamp }
        moveCount += 1
        moves.insert(
            LoggedMove(
                id: moveCount, notation: timed.event.move.notation, serial: timed.event.serial,
                gapMs: gap, source: timed.source, heldMs: releasing), at: 0)
        if moves.count > 40 { moves.removeLast() }
    }
}

private func zip<A, B>(_ a: A?, _ b: B?) -> (A, B)? {
    guard let a, let b else { return nil }
    return (a, b)
}
