import XCTest
import CubeLink
import CubingCore
@testable import CubingSession

/// Recording and history against the recorded TypeScript: `vectors/session.json`, and the Capacitor
/// app's database as the TypeScript store wrote it, `vectors/capacitor-solves.sqlite`.
final class SessionVectorTests: XCTestCase {
    // MARK: - The file

    struct Output: Decodable {
        let phase: String
        let scrambleText: String?
        let moveCount: Int
        let elapsedMs: Double?
        let hasRecord: Bool
    }

    struct Span: Decodable, Equatable {
        let phase: String
        let start: Int
        let end: Int
    }

    struct Completed: Decodable {
        let record: SolveRecord
        let failure: String?
        let crossFace: Int?
        let phases: [Span]?
        let phaseDurations: [Double?]
    }

    struct Step: Decodable {
        let op: String
        let now: Double
        let output: Output
        let facelets: String?
        let scramble: String?
        let move: String?
        let serial: Int?
        let cubeTimestamp: Double?
        let localTimestamp: Double?
        let completed: Completed?
    }

    struct RecorderCase: Decodable {
        let source: SolveSource
        let sessionId: String
        let steps: [Step]
    }

    struct StatsCase: Decodable {
        struct Record: Decodable {
            let startedAt: Double
            let durationMs: Double?
            let outcome: SolveOutcome
        }
        struct Average: Decodable {
            let current: Double?
            let best: Double?
        }
        struct Expected: Decodable {
            let count: Int
            let excluded: Int
            let best: Double?
            let worst: Double?
            let mean: Double?
            let averages: [String: Average]
        }
        let records: [Record]
        let stats: Expected
    }

    struct SqliteCase: Decodable {
        let file: String
        let sessions: [SessionRecord]
        let solves: [SolveRecord]
    }

    enum Case: Decodable {
        case recorder(RecorderCase), stats(StatsCase), sqlite(SqliteCase)

        private enum Key: String, CodingKey { case kind }

        init(from decoder: Decoder) throws {
            switch try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .kind) {
            case "recorder": self = .recorder(try RecorderCase(from: decoder))
            case "stats": self = .stats(try StatsCase(from: decoder))
            case "sqlite": self = .sqlite(try SqliteCase(from: decoder))
            case let kind: throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: kind))
            }
        }
    }

    struct Vectors: Decodable {
        let generator: String
        let cases: [Case]
    }

    static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static let vectors: Vectors = {
        let data = try! Data(contentsOf: repo.appendingPathComponent("vectors/session.json"))
        return try! JSONDecoder().decode(Vectors.self, from: data)
    }()

    // MARK: - Recorder

    func testRecordsAsTheTypeScriptDoes() throws {
        var cases = 0, finished = 0
        for case .recorder(let c) in Self.vectors.cases {
            cases += 1
            var clock = 0.0
            var ids = 0
            let recorder = SolveRecorder(
                sessionId: c.sessionId, source: c.source, now: { clock },
                makeId: {
                    ids += 1
                    return "\(c.sessionId)-solve-\(ids)"
                })
            // The tracker's side: the cube's position, and the live timeline the recorder is fed.
            let timeline = MoveTimeline()
            var cube = CubeState.solved

            for (i, step) in c.steps.enumerated() {
                clock = step.now
                let context = "case \(cases) (\(c.source.rawValue)) step \(i) \(step.op)"
                var completed: SolveRecord?
                switch step.op {
                case "state":
                    cube = try Facelets.state(from: step.facelets!)
                    recorder.handleState(cube)
                case "arm":
                    cube = try Facelets.state(from: step.facelets!)
                    try recorder.arm(step.scramble!, current: cube)
                case "startFrom":
                    cube = try Facelets.state(from: step.facelets!)
                    recorder.startFrom(cube)
                case "move":
                    let move = try Notation.parse(step.move!)[0]
                    let timed = timeline.add(
                        MoveEvent(
                            move: move, serial: step.serial!, cubeTimestamp: step.cubeTimestamp,
                            localTimestamp: step.localTimestamp))
                    cube = cube.applying([move])
                    let before = recorder.state.phase
                    recorder.handleMove(timed)
                    recorder.handleState(cube)
                    if before != .complete, recorder.state.phase == .complete { completed = recorder.state.record }
                case "discard":
                    completed = recorder.discard()
                case "reset":
                    recorder.reset()
                default:
                    XCTFail("unknown op \(step.op)")
                }

                let state = recorder.state
                XCTAssertEqual(state.phase.rawValue, step.output.phase, context)
                XCTAssertEqual(state.scrambleText, step.output.scrambleText, context)
                XCTAssertEqual(state.moveCount, step.output.moveCount, context)
                assertClose(state.elapsedMs, step.output.elapsedMs, "\(context): elapsed")
                XCTAssertEqual(state.record != nil, step.output.hasRecord, context)

                XCTAssertEqual(completed != nil, step.completed != nil, "\(context): finished a solve")
                if let completed, let expected = step.completed {
                    finished += 1
                    assertSame(completed, expected.record, context)
                    let segmented = try SegmentedSolve(completed)
                    XCTAssertEqual(segmented.segmentation.failure?.rawValue, expected.failure, context)
                    XCTAssertEqual(segmented.segmentation.segmentation?.crossFace, expected.crossFace, context)
                    XCTAssertEqual(
                        segmented.segmentation.segmentation?.spans.map {
                            Span(phase: $0.phase.rawValue, start: $0.start, end: $0.end)
                        }, expected.phases, context)
                    XCTAssertEqual(segmented.phaseDurations.count, expected.phaseDurations.count, context)
                    for (a, e) in zip(segmented.phaseDurations, expected.phaseDurations) {
                        assertClose(a, e, "\(context): phase duration")
                    }
                }
            }
        }
        XCTAssertEqual(cases, 100)
        XCTAssertGreaterThan(finished, 150)
    }

    // MARK: - Statistics

    func testComputesSessionStatsAsTheTypeScriptDoes() {
        var cases = 0
        for case .stats(let c) in Self.vectors.cases {
            cases += 1
            let records = c.records.enumerated().map { i, r in
                SolveRecord(
                    id: "\(i)", sessionId: "s", startedAt: r.startedAt, startFacelets: "",
                    scrambleText: nil, scrambleMatched: false, solution: "", moveCount: 0,
                    durationMs: r.durationMs, tps: nil, source: .manual, outcome: r.outcome,
                    moveTimestamps: [])
            }
            let stats = Stats.session(records)
            let context = "stats case \(cases)"
            XCTAssertEqual(stats.count, c.stats.count, context)
            XCTAssertEqual(stats.excluded, c.stats.excluded, context)
            assertClose(stats.best, c.stats.best, "\(context): best")
            assertClose(stats.worst, c.stats.worst, "\(context): worst")
            assertClose(stats.mean, c.stats.mean, "\(context): mean")
            for size in Stats.averageSizes {
                let expected = c.stats.averages[String(size)]!
                assertClose(stats.averages[size]?.current, expected.current, "\(context): ao\(size)")
                assertClose(stats.averages[size]?.best, expected.best, "\(context): best ao\(size)")
            }
        }
        XCTAssertEqual(cases, 100)
    }

    // MARK: - The Capacitor app's database

    var sqlite: SqliteCase {
        for case .sqlite(let c) in Self.vectors.cases { return c }
        fatalError("no sqlite case")
    }

    func testReadsTheDatabaseTheTypeScriptStoreWrote() throws {
        let contents = try CapacitorImport.read(Self.repo.appendingPathComponent(sqlite.file))
        XCTAssertEqual(contents.unreadable, 0)
        XCTAssertEqual(contents.sessions.sorted { $0.id < $1.id }, sqlite.sessions.sorted { $0.id < $1.id })
        XCTAssertEqual(contents.solves.count, sqlite.solves.count)
        for (a, e) in zip(contents.solves.sorted { $0.id < $1.id }, sqlite.solves.sorted { $0.id < $1.id }) {
            assertSame(a, e, "solve \(e.id)")
        }
    }

    @MainActor
    func testImportsIntoSwiftDataOnceAndOnlyOnce() throws {
        let library = SolveLibrary(try SolveLibrary.container(inMemory: true))
        let url = Self.repo.appendingPathComponent(sqlite.file)

        let first = try library.importCapacitor(from: url)
        XCTAssertEqual(first.added, sqlite.solves.count)
        XCTAssertEqual(first.sessions, sqlite.sessions.count)
        XCTAssertEqual(first.unreadable, 0)

        // Idempotent: nothing is duplicated by a second run.
        let second = try library.importCapacitor(from: url)
        XCTAssertEqual(second.added, 0)
        XCTAssertEqual(second.alreadyPresent, sqlite.solves.count)

        // And every record survives the trip through SwiftData intact.
        let stored = try library.allSolves().sorted { $0.id < $1.id }
        XCTAssertEqual(stored.count, sqlite.solves.count)
        for (a, e) in zip(stored, sqlite.solves.sorted { $0.id < $1.id }) { assertSame(a, e, "stored \(e.id)") }
        XCTAssertEqual(try library.sessions().count, sqlite.sessions.count)

        // Per session, newest first, as the history screen lists them.
        let session = sqlite.sessions[0].id
        let listed = try library.solves(in: session)
        XCTAssertEqual(listed.map(\.id).sorted(), sqlite.solves.filter { $0.sessionId == session }.map(\.id).sorted())
        XCTAssertEqual(listed.map(\.startedAt), listed.map(\.startedAt).sorted(by: >))
    }

    @MainActor
    func testReplacesAndDeletesByID() throws {
        let library = SolveLibrary(try SolveLibrary.container(inMemory: true))
        var solve = sqlite.solves[0]
        try library.put(solve)
        solve.outcome = .discarded
        try library.put(solve)
        XCTAssertEqual(try library.allSolves(), [solve])
        try library.delete(solve.id)
        XCTAssertEqual(try library.allSolves(), [])
    }

    func testMissingDatabaseIsAnErrorNotAnEmptyImport() {
        XCTAssertThrowsError(try CapacitorImport.read(URL(fileURLWithPath: "/nonexistent/cubing-companionSQLite.db")))
    }

    // MARK: - Helpers

    private func assertSame(_ a: SolveRecord, _ e: SolveRecord, _ context: String, file: StaticString = #filePath, line: UInt = #line) {
        var a = a, e = e
        assertClose(a.durationMs, e.durationMs, "\(context): duration", file: file, line: line)
        assertClose(a.tps, e.tps, "\(context): tps", file: file, line: line)
        XCTAssertEqual(a.moveTimestamps.count, e.moveTimestamps.count, context, file: file, line: line)
        for (x, y) in zip(a.moveTimestamps, e.moveTimestamps) { assertClose(x, y, "\(context): timestamp", file: file, line: line) }
        (a.durationMs, a.tps, a.moveTimestamps) = (nil, nil, [])
        (e.durationMs, e.tps, e.moveTimestamps) = (nil, nil, [])
        XCTAssertEqual(a, e, context, file: file, line: line)
    }

    private func assertClose(_ actual: Double?, _ expected: Double?, _ context: String, file: StaticString = #filePath, line: UInt = #line) {
        switch (actual, expected) {
        case (nil, nil): return
        case let (a?, e?): XCTAssertEqual(a, e, accuracy: 1e-6 * max(1, abs(e)), context, file: file, line: line)
        default: XCTFail("\(context): \(String(describing: actual)) != \(String(describing: expected))", file: file, line: line)
        }
    }
}
