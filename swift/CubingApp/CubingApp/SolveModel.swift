import CubeLink
import CubingCore
import CubingSession
import Foundation
import Observation

/// Recording solves: scrambles in, timed and scored solves out, kept in SwiftData.
///
/// Sits between the tracker and the recorder the way `CubeHarness` does in the web app, and keeps
/// its rules: an attempt is always armed while a cube is connected — on connecting, and again after
/// every solve or discard — and a finished solve is saved the moment it finishes.
@MainActor
@Observable
final class SolveModel {
    /// How far through the scramble the cube is.
    enum ScrambleProgress: Equatable {
        /// This many of the scramble's moves are done; `half` when the next is a half turn that
        /// has been turned one quarter — a smart cube reports `R2` as two quarter turns.
        case onTrack(done: Int, half: Bool)
        /// The cube matches no prefix of the scramble.
        case offTrack
    }

    /// A finished solve with everything the summary card shows, computed once.
    struct Finished {
        let record: SolveRecord
        let segmented: SegmentedSolve?
        let score: SolveScore?
    }

    private(set) var phase = RecorderPhase.idle
    private(set) var scramble: [Move] = []
    private(set) var scrambleText: String?
    private(set) var progress = ScrambleProgress.onTrack(done: 0, half: false)
    /// Wall-clock start of the running solve, for the live timer. The saved time is the fitted
    /// one from the cube's clock, which is what the summary shows once it finishes.
    private(set) var solveStartedAt: Date?
    private(set) var moveCount = 0
    private(set) var lastSolve: Finished?
    private(set) var sessionId: String
    private(set) var importSummary: SolveLibrary.ImportSummary?
    private(set) var error: String?

    let library: SolveLibrary
    private let pool: ScramblePool?
    private var recorder: SolveRecorder
    private var prefixes: [String] = []
    private var halves: [Set<String>] = []
    private unowned let cube: CubeModel

    /// The position to plan for — the scramble's, the moment it is armed — and the moment the cube
    /// matches it, when inspection begins.
    var onPlanTarget: ((CubeState) -> Void)?
    var onInspection: (() -> Void)?

    private static let sessionKey = "session.current"
    private static let importedKey = "capacitorImport.done"

    init(cube: CubeModel, library: SolveLibrary) {
        self.cube = cube
        self.library = library
        pool = Bundle.main.url(forResource: "scrambles", withExtension: "txt")
            .flatMap { try? ScramblePool(contentsOf: $0) }
        let session = UserDefaults.standard.string(forKey: Self.sessionKey) ?? Self.newSessionId()
        sessionId = session
        recorder = SolveRecorder(sessionId: session, source: .smartCube)
        UserDefaults.standard.set(session, forKey: Self.sessionKey)
        try? library.ensureSession(Self.sessionRecord(session))

        cube.onTrackedMove = { [weak self] timed, state in self?.moved(timed, state) }
        cube.onReseed = { [weak self] state in self?.reseeded(state) }
        cube.onReady = { [weak self] in self?.armIfIdle() }
        importCapacitorHistoryOnce()
    }

    // MARK: Actions

    /// A fresh scramble, abandoning whatever was armed.
    func newScramble() {
        let text = pool?.next() ?? Self.randomMoveScramble()
        guard let moves = try? Notation.parse(text) else { return }
        do {
            try recorder.arm(text, current: cube.trackedState)
        } catch {
            self.error = "\(error)"
            return
        }
        scramble = moves
        scrambleText = text
        // Every prefix of the scramble as a position, and each half turn's two halfway positions,
        // so progress is a lookup rather than a search.
        var state = CubeState.solved
        prefixes = [Facelets.string(from: state)]
        halves = []
        for move in moves {
            halves.append(
                move.amount == 2
                    ? [1, -1].reduce(into: Set<String>()) {
                        $0.insert(Facelets.string(from: state.applying([Move(family: move.family, amount: $1)])))
                    } : [])
            state = state.applying([move])
            prefixes.append(Facelets.string(from: state))
        }
        onPlanTarget?(state)
        sync()
    }

    /// Time a solve from the position the cube is in now, without a scramble.
    func startFromHere() {
        onPlanTarget?(cube.trackedState)
        recorder.startFrom(cube.trackedState)
        scramble = []
        scrambleText = nil
        sync()
    }

    /// Abandon the running solve. Kept, as the TypeScript does, but marked discarded.
    func discard() {
        if let record = recorder.discard() { finish(record) }
        sync()
        armIfIdle()
    }

    func startNewSession() {
        sessionId = Self.newSessionId()
        UserDefaults.standard.set(sessionId, forKey: Self.sessionKey)
        try? library.ensureSession(Self.sessionRecord(sessionId))
        recorder = SolveRecorder(sessionId: sessionId, source: .smartCube)
        lastSolve = nil
        sync()
        armIfIdle()
    }

    func delete(_ id: String) {
        try? library.delete(id)
        if lastSolve?.record.id == id { lastSolve = nil }
    }

    // MARK: Events

    /// Order matters, as in the web app: the move that solves the cube reaches the recorder before
    /// the position it produces.
    private func moved(_ timed: TimedMove, _ state: CubeState) {
        let before = recorder.state.phase
        recorder.handleMove(timed)
        recorder.handleState(state)
        let after = recorder.state
        if before == .ready, after.phase == .solving { solveStartedAt = Date() }
        if before != .complete, after.phase == .complete, let record = after.record { finish(record) }
        updateProgress(state)
        sync()
        armIfIdle()
    }

    /// The position changed without a move — a resync — so the recorder must be told, or a cube
    /// re-seeded straight onto the scramble would never arm.
    private func reseeded(_ state: CubeState) {
        recorder.handleState(state)
        updateProgress(state)
        sync()
    }

    private func finish(_ record: SolveRecord) {
        do {
            try library.put(record)
        } catch {
            self.error = "Could not save the solve: \(error)"
        }
        lastSolve = analyse(record)
        solveStartedAt = nil
    }

    /// Keep an attempt armed while connected: on connecting, and after every solve or discard.
    private func armIfIdle() {
        guard cube.isConnected, phase == .idle || phase == .complete else { return }
        newScramble()
    }

    private func sync() {
        let state = recorder.state
        if phase != .ready, state.phase == .ready { onInspection?() }
        phase = state.phase
        moveCount = state.moveCount
        if phase != .solving { solveStartedAt = nil }
    }

    private func updateProgress(_ state: CubeState) {
        guard phase == .scrambling, !prefixes.isEmpty else { return }
        let facelets = Facelets.string(from: state)
        if let done = prefixes.lastIndex(of: facelets) {
            progress = .onTrack(done: done, half: false)
        } else if let done = halves.firstIndex(where: { $0.contains(facelets) }) {
            progress = .onTrack(done: done, half: true)
        } else {
            progress = .offTrack
        }
    }

    // MARK: Analysis

    /// Segment and score a solve, rated against the corpus and — for speed — against this session.
    func analyse(_ record: SolveRecord) -> Finished {
        guard let segmented = try? SegmentedSolve(record), let spans = segmented.segmentation.segmentation?.spans
        else { return Finished(record: record, segmented: nil, score: nil) }
        let metrics = Metrics.compute(spans, record.moveTimestamps)
        let recent = ((try? library.solves(in: record.sessionId)) ?? [])
            .filter { $0.id != record.id && $0.outcome == .solved }
            .compactMap(\.durationMs)
            .prefix(50)
        let score = Scoring.score(
            metrics, rotationsObserved: record.source.observesRotations, recentDurationsMs: Array(recent))
        return Finished(record: record, segmented: segmented, score: score)
    }

    // MARK: Importing

    /// The Capacitor app's history, once, if its database is here — which it will be after the
    /// cutover, when this app takes over that bundle identifier and inherits its container.
    private func importCapacitorHistoryOnce() {
        let url = CapacitorImport.defaultLocation
        guard !UserDefaults.standard.bool(forKey: Self.importedKey),
            FileManager.default.fileExists(atPath: url.path)
        else { return }
        do {
            importSummary = try library.importCapacitor(from: url)
            UserDefaults.standard.set(true, forKey: Self.importedKey)
        } catch {
            self.error = "Could not import the previous app's solves: \(error)"
        }
    }

    // MARK: Helpers

    private static func newSessionId() -> String {
        "session-\(Int(Date().timeIntervalSince1970 * 1000))"
    }

    private static func sessionRecord(_ id: String) -> SessionRecord {
        SessionRecord(
            id: id, startedAt: Date().timeIntervalSince1970 * 1000,
            label: Date().formatted(date: .abbreviated, time: .shortened))
    }

    /// Only if the bundled pool is missing: twenty random face turns, never the same face twice or
    /// three on one axis — the web app's own fallback.
    static func randomMoveScramble() -> String {
        let faces = ["U", "D", "L", "R", "F", "B"]
        let axis = ["U": 0, "D": 0, "L": 1, "R": 1, "F": 2, "B": 2]
        var moves: [String] = []
        var previous: String?, beforeThat: String?
        while moves.count < 20 {
            let face = faces.randomElement()!
            if face == previous { continue }
            if let previous, let beforeThat, axis[face] == axis[previous], axis[face] == axis[beforeThat] { continue }
            moves.append(face + ["", "'", "2"].randomElement()!)
            (beforeThat, previous) = (previous, face)
        }
        return moves.joined(separator: " ")
    }
}
