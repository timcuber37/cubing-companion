import XCTest
import CubingCore
@testable import CubeLink

/// The cube link against the recorded TypeScript: `vectors/cubelink.json`.
///
/// Most cases are replays, not pairs — the drivers are stateful, so a case feeds frames in order
/// and compares what came out after each one: the events, the commands the driver chose to send,
/// and whether it hung up. A port that decodes every frame right but gets the order wrong fails.
final class CubeLinkVectorTests: XCTestCase {
    // MARK: - The file

    struct Pieces: Decodable, Equatable { let CP, CO, EP, EO: [Int] }
    struct Quaternion: Decodable, Equatable { let x, y, z, w: Double }
    struct Velocity: Decodable, Equatable { let x, y, z: Int }

    /// Every event shape in one struct, so a Swift event can be flattened and compared whole.
    struct Event: Decodable, Equatable {
        var type: String
        var serial: Int?
        var timestamp: Double?
        var localTimestamp: Double?
        var cubeTimestamp: Double?
        var face: Int?
        var direction: Int?
        var move: String?
        var facelets: String?
        var state: Pieces?
        var quaternion: Quaternion?
        var velocity: Velocity?
        var batteryLevel: Int?
        var hardwareName: String?
        var hardwareVersion: String?
        var softwareVersion: String?
        var productDate: String?
        var gyroSupported: Bool?

        init(type: String) { self.type = type }

        init(_ event: GanEvent) {
            switch event {
            case .move(let m):
                self.init(type: "MOVE")
                (serial, timestamp, localTimestamp, cubeTimestamp) =
                    (m.serial, m.timestamp, m.localTimestamp, m.cubeTimestamp)
                (face, direction, move) = (m.face, m.direction, m.move)
            case .facelets(let f):
                self.init(type: "FACELETS")
                (serial, timestamp, facelets) = (f.serial, f.timestamp, f.facelets)
                state = Pieces(CP: f.state.cp, CO: f.state.co, EP: f.state.ep, EO: f.state.eo)
            case .gyro(let g):
                self.init(type: "GYRO")
                timestamp = g.timestamp
                quaternion = Quaternion(x: g.quaternion.x, y: g.quaternion.y, z: g.quaternion.z, w: g.quaternion.w)
                velocity = g.velocity.map { Velocity(x: $0.x, y: $0.y, z: $0.z) }
            case .battery(let t, let level):
                self.init(type: "BATTERY")
                (timestamp, batteryLevel) = (t, level)
            case .hardware(let h):
                self.init(type: "HARDWARE")
                timestamp = h.timestamp
                (hardwareName, hardwareVersion, softwareVersion) =
                    (h.hardwareName, h.hardwareVersion, h.softwareVersion)
                (productDate, gyroSupported) = (h.productDate, h.gyroSupported)
            case .disconnect(let t):
                self.init(type: "DISCONNECT")
                timestamp = t
            }
        }
    }

    struct Step: Decodable {
        let now: Double
        /// Absent on a timer tick, which calls `retry` instead of delivering a frame.
        let hex: String?
        let tick: Bool?
        let events: [Event]
        let sent: [String]
        let disconnects: Int
    }

    struct Replay: Decodable {
        let generation: String
        /// Recovery sessions only; everything else runs the reference strategy.
        let recovery: String?
        let steps: [Step]
    }

    struct Crypto: Decodable {
        struct Frame: Decodable { let encrypted, decrypted: String }
        struct Command: Decodable { let generation, command, plain, gan, moyu: String }
        let deviceName, mac, moyuName, moyuMac: String
        let frames: [Frame]
        let commands: [Command]
    }

    struct Commands: Decodable {
        struct Command: Decodable { let command, hex: String }
        let generation: String
        let commands: [Command]
    }

    struct MacCases: Decodable {
        struct Case: Decodable {
            let companyId: Int
            let payload: String
            let mac: String?
        }
        let cases: [Case]
    }

    struct Timeline: Decodable {
        struct Input: Decodable {
            let move: String
            let serial: Int
            let cubeTimestamp: Double?
            let localTimestamp: Double?
        }
        struct Output: Decodable {
            let timestamp: Double?
            let source: String
        }
        let windowSize: Int?
        let events: [Input]
        let streamed: [Output]
        let skewPercent: Double?
        let anchorCount: Int
        let retimed: [Output]
    }

    struct Tracker: Decodable {
        struct Output: Decodable, Equatable {
            let type: String
            var move: String?
            var serial: Int?
            var timestamp: Double?
            var source: String?
            var reason: String?
            var expected: String?
            var actual: String?
            var facelets: String?
        }
        struct Step: Decodable {
            let op: String
            let move: String?
            let serial: Int?
            let cubeTimestamp: Double?
            let localTimestamp: Double?
            let truth: String?
            let output: [Output]
        }
        let initial: String
        let steps: [Step]
        let final: String
    }

    enum Case: Decodable {
        case crypto(Crypto), commands(Commands), replay(kind: String, Replay), mac(MacCases)
        case timeline(Timeline), tracker(Tracker)

        private enum Key: String, CodingKey { case kind }

        init(from decoder: Decoder) throws {
            let kind = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .kind)
            switch kind {
            case "crypto": self = .crypto(try Crypto(from: decoder))
            case "commands": self = .commands(try Commands(from: decoder))
            case "decode", "capture", "recovery": self = .replay(kind: kind, try Replay(from: decoder))
            case "mac": self = .mac(try MacCases(from: decoder))
            case "timeline": self = .timeline(try Timeline(from: decoder))
            case "tracker": self = .tracker(try Tracker(from: decoder))
            default: throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: kind))
            }
        }
    }

    struct Vectors: Decodable {
        let generator: String
        let cases: [Case]
    }

    static let vectors: Vectors = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try! Data(contentsOf: repo.appendingPathComponent("vectors/cubelink.json"))
        return try! JSONDecoder().decode(Vectors.self, from: data)
    }()

    static func bytes(_ hex: String) -> [UInt8] {
        let chars = Array(hex)
        return stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...$0 + 1]), radix: 16)! }
    }

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String($0, radix: 16).count == 1 ? "0" + String($0, radix: 16) : String($0, radix: 16) }
            .joined()
    }

    final class Recorder: DriverConnection {
        var sent: [String] = []
        var disconnects = 0
        func send(_ message: [UInt8]) { sent.append(CubeLinkVectorTests.hex(message)) }
        func disconnect() { disconnects += 1 }
    }

    // MARK: - Tests

    func testTheFileIsTheOneExpected() {
        XCTAssertEqual(Self.vectors.generator, "cubelink")
    }

    func testDecryptsTheRealCaptureAndEncryptsCommands() throws {
        guard case .crypto(let c) = Self.vectors.cases.first(where: { if case .crypto = $0 { true } else { false } })
        else { return XCTFail("no crypto case") }
        let gan = try GanEncrypter.forCube(named: c.deviceName, mac: c.mac)
        let moyu = try GanEncrypter.forCube(named: c.moyuName, mac: c.moyuMac)
        XCTAssertEqual(c.frames.count, 1213)
        for (i, frame) in c.frames.enumerated() {
            XCTAssertEqual(Self.hex(gan.decrypt(Self.bytes(frame.encrypted))), frame.decrypted, "frame \(i)")
        }
        for command in c.commands {
            let plain = Self.bytes(command.plain)
            XCTAssertEqual(Self.hex(gan.encrypt(plain)), command.gan, "\(command.generation) \(command.command)")
            XCTAssertEqual(Self.hex(moyu.encrypt(plain)), command.moyu, "\(command.generation) \(command.command)")
            XCTAssertEqual(gan.decrypt(gan.encrypt(plain)), plain)
        }
    }

    func testBuildsCommandMessages() {
        for case .commands(let c) in Self.vectors.cases {
            let driver = GanProtocol(rawValue: c.generation)!.driver(now: { 0 })
            for command in c.commands {
                XCTAssertEqual(
                    driver.command(GanCommand(rawValue: command.command)!).map(Self.hex), command.hex,
                    "\(c.generation) \(command.command)")
            }
        }
    }

    /// Generated messages, the real capture, and the simulated cube that answers history requests.
    func testReplaysFrameForFrame() {
        var replays = 0
        var frames = 0
        for case .replay(let kind, let replay) in Self.vectors.cases {
            replays += 1
            var clock = 0.0
            let recovery = RecoveryMode(rawValue: replay.recovery ?? "reference")!
            let driver = GanProtocol(rawValue: replay.generation)!.driver(now: { clock }, recovery: recovery)
            let io = Recorder()
            for (i, step) in replay.steps.enumerated() {
                clock = step.now
                let events: [Event]
                if step.tick == true {
                    driver.retry(connection: io)
                    events = []
                } else {
                    events = driver.handle(Self.bytes(step.hex!), connection: io).map(Event.init)
                }
                let context = "\(kind) \(recovery) \(replay.generation) step \(i): \(step.hex ?? "tick")"
                XCTAssertEqual(events, step.events, context)
                XCTAssertEqual(io.sent, step.sent, "\(context): commands sent")
                XCTAssertEqual(io.disconnects, step.disconnects, "\(context): disconnects")
                let agreed = events == step.events && io.sent == step.sent
                io.sent.removeAll()
                io.disconnects = 0
                frames += 1
                // One disagreement desynchronises every later frame; stop at the first.
                if !agreed { break }
            }
        }
        XCTAssertEqual(replays, 16)  // three decode, one capture, six reference and six eager recoveries
        XCTAssertGreaterThan(frames, 5000)
    }

    func testFindsTheMacInManufacturerData() {
        for case .mac(let m) in Self.vectors.cases {
            for c in m.cases {
                let raw = [UInt8(c.companyId & 0xff), UInt8(c.companyId >> 8)] + Self.bytes(c.payload)
                XCTAssertEqual(Mac.fromManufacturerData(raw), c.mac, "company \(c.companyId) payload \(c.payload)")
            }
        }
    }

    func testFitsTheClockAsTheTypeScriptDoes() throws {
        var cases = 0
        for case .timeline(let t) in Self.vectors.cases {
            cases += 1
            let events = try t.events.map {
                MoveEvent(
                    move: try Notation.parse($0.move)[0], serial: $0.serial,
                    cubeTimestamp: $0.cubeTimestamp, localTimestamp: $0.localTimestamp)
            }
            let timeline = MoveTimeline(windowSize: t.windowSize ?? 64)
            let streamed = events.map(timeline.add)
            for (i, (actual, expected)) in zip(streamed, t.streamed).enumerated() {
                XCTAssertEqual(actual.source.rawValue, expected.source, "streamed \(i)")
                assertClose(actual.timestamp, expected.timestamp, "streamed \(i)")
            }
            assertClose(timeline.skewPercent, t.skewPercent, "skew")
            XCTAssertEqual(timeline.anchorCount, t.anchorCount)
            for (i, (actual, expected)) in zip(MoveTimeline.retime(events), t.retimed).enumerated() {
                XCTAssertEqual(actual.source.rawValue, expected.source, "retimed \(i)")
                assertClose(actual.timestamp, expected.timestamp, "retimed \(i)")
            }
        }
        XCTAssertEqual(cases, 60)
    }

    final class FakeCube: CubeStateSource {
        var truth: CubeState
        init(_ truth: CubeState) { self.truth = truth }
        func queryState() async throws -> CubeState { truth }
    }

    @MainActor
    func testTracksAndResynchronises() async throws {
        var cases = 0
        for case .tracker(let t) in Self.vectors.cases {
            cases += 1
            let cube = FakeCube(try Facelets.state(from: t.initial))
            let tracker = CubeTracker(source: cube)
            var output: [Tracker.Output] = []
            tracker.onMove = { timed in
                var o = Tracker.Output(type: "move")
                o.move = timed.event.move.notation
                o.serial = timed.event.serial
                o.timestamp = timed.timestamp
                o.source = timed.source.rawValue
                output.append(o)
            }
            tracker.onDesync = { event in
                var o = Tracker.Output(type: "desync")
                (o.reason, o.expected, o.actual) = (event.reason.rawValue, event.expected, event.actual)
                output.append(o)
            }
            tracker.onReseed = { state in
                var o = Tracker.Output(type: "reseed")
                o.facelets = Facelets.string(from: state)
                output.append(o)
            }

            for (i, step) in t.steps.enumerated() {
                switch step.op {
                case "start":
                    try await tracker.start()
                case "missed":
                    cube.truth = cube.truth.applying(try Notation.parse(step.move!))
                case "move":
                    let move = try Notation.parse(step.move!)[0]
                    cube.truth = cube.truth.applying([move])
                    tracker.handle(
                        MoveEvent(
                            move: move, serial: step.serial!, cubeTimestamp: step.cubeTimestamp,
                            localTimestamp: step.localTimestamp))
                    await tracker.settle()
                case "verify":
                    XCTAssertEqual(Facelets.string(from: cube.truth), step.truth, "the replay itself drifted")
                    await tracker.verify()
                default:
                    XCTFail("unknown op \(step.op)")
                }
                XCTAssertEqual(output, step.output, "tracker case \(cases) step \(i) (\(step.op))")
                output.removeAll()
            }
            XCTAssertEqual(Facelets.string(from: tracker.state), t.final)
        }
        XCTAssertEqual(cases, 40)
    }

    private func assertClose(
        _ actual: Double?, _ expected: Double?, _ context: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        switch (actual, expected) {
        case (nil, nil): return
        case let (a?, e?): XCTAssertEqual(a, e, accuracy: 1e-6 * max(1, abs(e)), context, file: file, line: line)
        default: XCTFail("\(context): \(String(describing: actual)) != \(String(describing: expected))", file: file, line: line)
        }
    }
}

extension CubeLinkVectorTests.Tracker.Output {
    init(type: String) { self.type = type }
}
