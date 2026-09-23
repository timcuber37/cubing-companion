/// The Gen2, Gen3 and Gen4 GAN protocol drivers, and the move buffer the last two share.
///
/// Ported from `gen2.ts`, `gen3.ts`, `gen4.ts` and `buffer.ts`. Synchronous where the TypeScript is
/// async: those `await`s exist only because a JavaScript Bluetooth write returns a promise, and a
/// CoreBluetooth write is fire-and-forget. Synchronous drivers are deterministic, which is what lets
/// `vectors/cubelink.json` replay them frame for frame.

/// What a driver needs from its connection: a way to ask, and a way to give up.
public protocol DriverConnection: AnyObject {
    func send(_ message: [UInt8])
    func disconnect()
}

public protocol GanDriver: AnyObject {
    func command(_ command: GanCommand) -> [UInt8]?
    /// Decode one decrypted message. May send commands or disconnect through `connection`.
    func handle(_ message: [UInt8], connection: DriverConnection) -> [GanEvent]
    /// Called on a timer by the connection; see `BufferedMoveDriver.retry`.
    func retry(connection: DriverConnection)
}

extension GanDriver {
    public func retry(connection: DriverConnection) {}
}

/// How a driver recovers lost moves. See `RecoveryMode` in `buffer.ts` for the measurements behind
/// eager, which the app uses; reference reproduces `gan-web-bluetooth` exactly.
public enum RecoveryMode: String, Sendable {
    case reference, eager

    /// Hold-back for an identical history request, and the connection's retry interval. Chosen by
    /// simulation — see `REQUEST_REPEAT_MS` in `buffer.ts`.
    public static let repeatMs = 100.0
}

public enum GanProtocol: String, Sendable, CaseIterable {
    case gen2, gen3, gen4

    /// Whether a plain command asks the cube to resend moves. Gen2 batches instead of asking.
    public func isHistoryRequest(_ message: [UInt8]) -> Bool {
        switch self {
        case .gen2: false
        case .gen3: message.count > 1 && message[0] == 0x68 && message[1] == 0x03
        case .gen4: message.first == 0xd1
        }
    }

    /// Whether a decrypted notification is the cube's answer to one.
    public func isHistoryResponse(_ message: [UInt8]) -> Bool {
        switch self {
        case .gen2: false
        case .gen3: message.count > 1 && message[0] == 0x55 && message[1] == 0x06
        case .gen4: message.first == 0xd1
        }
    }

    public func driver(now: @escaping () -> Double, recovery: RecoveryMode = .reference) -> GanDriver {
        switch self {
        case .gen2: Gen2Driver(now: now)
        case .gen3: Gen3Driver(now: now, recovery: recovery)
        case .gen4: Gen4Driver(now: now, recovery: recovery)
        }
    }
}

private func signed15(_ value: Int) -> Double {
    Double((1 - (value >> 15) * 2) * (value & 0x7fff)) / Double(0x7fff)
}

private func signed3(_ value: Int) -> Int {
    (1 - (value >> 3) * 2) * (value & 0x7)
}

/// Zero-padded decimal, as `padStart` writes it.
private func padded(_ value: Int, _ width: Int) -> String {
    let digits = String(value)
    return String(repeating: "0", count: max(0, width - digits.count)) + digits
}

/// Latin-1 characters, as `String.fromCharCode` produces from single bytes.
private func character(_ code: Int) -> Character {
    Character(Unicode.Scalar(UInt8(code)))
}

private func message(size: Int, prefix: [UInt8]) -> [UInt8] {
    prefix + [UInt8](repeating: 0, count: size - prefix.count)
}

// MARK: - Gen2

/// GAN356 i, GAN356 i Carry, Monster Go AI and others. Batches up to seven moves per event.
final class Gen2Driver: GanDriver {
    private let now: () -> Double
    private var lastSerial = -1
    private var lastMoveTimestamp = 0.0
    private var cubeTimestamp = 0.0

    init(now: @escaping () -> Double) { self.now = now }

    func command(_ command: GanCommand) -> [UInt8]? {
        switch command {
        case .requestFacelets: message(size: 20, prefix: [0x04])
        case .requestHardware: message(size: 20, prefix: [0x05])
        case .requestBattery: message(size: 20, prefix: [0x09])
        case .requestReset:
            message(size: 20, prefix: [0x0a, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab])
        }
    }

    func handle(_ bytes: [UInt8], connection: DriverConnection) -> [GanEvent] {
        let timestamp = now()
        var events: [GanEvent] = []
        let view = MessageView(bytes)

        switch view.word(0, 4) {
        case 0x01:
            events.append(
                .gyro(
                    GanGyro(
                        timestamp: timestamp,
                        quaternion: (
                            x: signed15(view.word(20, 16)), y: signed15(view.word(36, 16)),
                            z: signed15(view.word(52, 16)), w: signed15(view.word(4, 16))
                        ),
                        velocity: (
                            x: signed3(view.word(68, 4)), y: signed3(view.word(72, 4)),
                            z: signed3(view.word(76, 4))
                        ))))
        case 0x02:
            guard lastSerial != -1 else { break }
            let serial = view.word(4, 8)
            let diff = min((serial - lastSerial) & 0xff, 7)
            lastSerial = serial
            guard diff > 0 else { break }
            for i in stride(from: diff - 1, through: 0, by: -1) {
                let face = view.word(12 + 5 * i, 4)
                let direction = view.word(16 + 5 * i, 1)
                var elapsed = Double(view.word(47 + 16 * i, 16))
                if elapsed == 0 { elapsed = timestamp - lastMoveTimestamp }
                cubeTimestamp += elapsed
                events.append(
                    .move(
                        GanMove(
                            serial: (serial - i) & 0xff, timestamp: timestamp,
                            localTimestamp: i == 0 ? timestamp : nil, cubeTimestamp: cubeTimestamp,
                            face: face, direction: direction,
                            // Gen2 does not validate the face; a bad nibble names no face at all.
                            move: face < 6 ? moveName(face, direction) : Self.unknownMove(direction))))
            }
            lastMoveTimestamp = timestamp
        case 0x04:
            let serial = view.word(4, 8)
            if lastSerial == -1 { lastSerial = serial }
            let cp = (0..<7).map { view.word(12 + $0 * 3, 3) }
            let co = (0..<7).map { view.word(33 + $0 * 2, 2) }
            let ep = (0..<11).map { view.word(47 + $0 * 4, 4) }
            let eo = (0..<11).map { view.word(91 + $0, 1) }
            if let report = GanFacelets.report(
                serial: serial, timestamp: timestamp, cp: cp, co: co, ep: ep, eo: eo)
            {
                events.append(report)
            }
        case 0x05:
            let name = String((0..<8).map { character(view.word($0 * 8 + 40, 8)) })
            events.append(
                .hardware(
                    GanHardware(
                        timestamp: timestamp, hardwareName: name,
                        hardwareVersion: "\(view.word(8, 8)).\(view.word(16, 8))",
                        softwareVersion: "\(view.word(24, 8)).\(view.word(32, 8))",
                        productDate: nil, gyroSupported: view.word(104, 1) != 0)))
        case 0x09:
            events.append(.battery(timestamp: timestamp, level: min(view.word(8, 8), 100)))
        case 0x0d:
            connection.disconnect()
        default:
            break
        }
        return events
    }

    /// `moveName` for a face index past `URFDLB`. JavaScript's `charAt` returns "" out of range,
    /// so the TypeScript produces just the direction mark — or an empty string.
    static func unknownMove(_ direction: Int) -> String { direction == 1 ? "'" : "" }
}

// MARK: - The move buffer

/// Move ordering and gap recovery, shared by Gen3 and Gen4. See `buffer.ts`.
class BufferedMoveDriver {
    let now: () -> Double
    /// Serial of the newest move seen, from any source.
    var serial = -1
    /// Serial of the newest move actually released downstream.
    var lastSerial = -1
    var lastLocalTimestamp: Double?
    var moveBuffer: [GanMove] = []
    let recovery: RecoveryMode
    /// The last history request, so an identical one is not repeated while its answer is due.
    private var lastRequest: (serial: Int, count: Int, at: Double)?

    private static let maxPending = 16

    init(now: @escaping () -> Double, recovery: RecoveryMode = .reference) {
        self.now = now
        self.recovery = recovery
    }

    /// Ask the cube to resend `count` moves ending at `serial`. Layout differs per generation.
    func requestMoveHistory(_ connection: DriverConnection, serial: Int, count: Int) {
        fatalError("subclass responsibility")
    }

    /// Release moves while they are contiguous; ask for history at the first gap, if there is a
    /// connection to ask through — there is not while processing a history response.
    func evictMoveBuffer(_ connection: DriverConnection?) -> [GanEvent] {
        var evicted: [GanEvent] = []
        while let head = moveBuffer.first {
            let diff = lastSerial == -1 ? 1 : (head.serial - lastSerial) & 0xff
            if diff > 1 {
                if let connection {
                    if recovery == .eager {
                        requestMissing(connection)
                    } else {
                        requestMoveHistory(connection, serial: head.serial, count: diff)
                    }
                }
                break
            }
            evicted.append(.move(moveBuffer.removeFirst()))
            lastSerial = head.serial
        }
        if let connection, moveBuffer.count > Self.maxPending { connection.disconnect() }
        return evicted
    }

    /// Does `serial` fall between `start` and `end`, counting around the 256 wrap?
    func isSerialInRange(
        _ start: Int, _ end: Int, _ serial: Int, closedStart: Bool = false, closedEnd: Bool = false
    ) -> Bool {
        ((end - start) & 0xff) >= ((serial - start) & 0xff)
            && (closedStart || ((start - serial) & 0xff) > 0)
            && (closedEnd || ((end - serial) & 0xff) > 0)
    }

    /// Slot a recovered move into the buffer, if it is genuinely one of the missing ones.
    func injectMissedMove(_ move: GanMove) {
        if recovery == .eager {
            guard lastSerial != -1 else { return }
            let ahead = (move.serial - lastSerial) & 0xff
            // Released already, or beyond anything the cube has said it played.
            if ahead == 0 || ahead > (serial - lastSerial) & 0xff { return }
            if moveBuffer.contains(where: { $0.serial == move.serial }) { return }
            // In serial order, wherever it falls — not only just below the first held move.
            let index = moveBuffer.firstIndex { ($0.serial - lastSerial) & 0xff > ahead } ?? moveBuffer.count
            moveBuffer.insert(move, at: index)
            return
        }
        if let head = moveBuffer.first {
            if moveBuffer.contains(where: { $0.serial == move.serial }) { return }
            if !isSerialInRange(lastSerial, head.serial, move.serial) { return }
            if move.serial == (head.serial - 1) & 0xff { moveBuffer.insert(move, at: 0) }
            return
        }
        if isSerialInRange(lastSerial, serial, move.serial, closedStart: false, closedEnd: true) {
            moveBuffer.insert(move, at: 0)
        }
    }

    /// On a periodic facelet report: has anything gone missing since the last released move?
    func checkIfMoveMissed(_ connection: DriverConnection) {
        let diff = (serial - lastSerial) & 0xff
        if diff == 0 { return }
        // Serial 0 is skipped: the facelet report at the 255→0 wrap is unreliable.
        if serial == 0 { return }
        if recovery == .eager { return requestMissing(connection) }
        let startSerial = moveBuffer.first?.serial ?? (serial + 1) & 0xff
        requestMoveHistory(connection, serial: startSerial, count: diff + 1)
    }

    /// A live move. In eager mode one already held or released is a duplicate — history can fetch a
    /// move before its own late notification arrives — and applying it twice would desynchronise.
    func acceptLiveMove(_ move: GanMove) {
        if recovery == .eager, lastSerial != -1 {
            let ahead = (move.serial - lastSerial) & 0xff
            if ahead == 0 || ahead > 0x80 { return }
            if moveBuffer.contains(where: { $0.serial == move.serial }) { return }
        }
        moveBuffer.append(move)
    }

    /// Ask again for anything still missing, if the last request has gone unanswered too long.
    /// Eager only; the connection calls it on a timer so a dropped answer is retried during a pause.
    func retry(connection: DriverConnection) {
        guard recovery == .eager, lastSerial != -1 else { return }
        if !moveBuffer.isEmpty || (serial - lastSerial) & 0xff != 0 { requestMissing(connection) }
    }

    /// After a history answer: in eager mode, and only after progress, ask for what is still missing.
    func afterHistory(_ connection: DriverConnection, released: [GanEvent]) {
        if recovery == .eager, !released.isEmpty { requestMissing(connection) }
    }

    /// The earliest run of missing moves, unless that exact request is still awaiting its answer.
    private func requestMissing(_ connection: DriverConnection) {
        guard lastSerial != -1 else { return }
        let above = moveBuffer.first?.serial ?? (serial + 1) & 0xff
        let count = (above - lastSerial) & 0xff
        guard count > 1 else { return }
        let window = alignHistoryWindow(above, count)
        let at = now()
        if let last = lastRequest, last.serial == window.serial, last.count == window.count,
            at - last.at < RecoveryMode.repeatMs
        {
            return
        }
        lastRequest = (window.serial, window.count, at)
        requestMoveHistory(connection, serial: above, count: count)
    }

    /// Responses begin at an odd serial with an even count, and must not cross 255→0.
    ///
    /// The count can reach 256 — a gap of 255 rounded up to even — and the request carries it in
    /// one byte. JavaScript's `Uint8Array` wraps that to 0 silently, so the request builders use
    /// `truncatingIfNeeded` to send the same byte rather than trapping.
    func alignHistoryWindow(_ serial: Int, _ count: Int) -> (serial: Int, count: Int) {
        var start = serial
        var length = count
        if start % 2 == 0 { start = (start - 1) & 0xff }
        if length % 2 == 1 { length += 1 }
        return (start, min(length, start + 1))
    }

    /// The shared shape of a live move and a history response; only the offsets differ.
    struct Layout {
        let cubeTimestamp, serial, direction, face: Int
        let historyStart, historyNibbles: Int
    }

    static let liveFaceOrder = [2, 32, 8, 1, 16, 4]
    static let historyFaceOrder = [1, 5, 3, 0, 4, 2]

    func handleMove(_ view: MessageView, _ layout: Layout, _ timestamp: Double, _ connection: DriverConnection) -> [GanEvent] {
        guard lastSerial != -1 else { return [] }
        lastLocalTimestamp = timestamp
        let cubeTimestamp = Double(view.word(layout.cubeTimestamp, 32, littleEndian: true))
        serial = view.word(layout.serial, 16, littleEndian: true)
        let direction = view.word(layout.direction, 2)
        if let face = Self.liveFaceOrder.firstIndex(of: view.word(layout.face, 6)) {
            acceptLiveMove(
                GanMove(
                    serial: serial, timestamp: timestamp, localTimestamp: timestamp,
                    cubeTimestamp: cubeTimestamp, face: face, direction: direction,
                    move: moveName(face, direction)))
        }
        return evictMoveBuffer(connection)
    }

    func handleHistory(
        _ view: MessageView, _ layout: Layout, _ dataLength: Int, _ timestamp: Double,
        _ connection: DriverConnection
    ) -> [GanEvent] {
        let startSerial = view.word(layout.historyStart, 8)
        let count = (dataLength - 1) * 2
        for i in stride(from: 0, to: count, by: 1) {
            guard
                let face = Self.historyFaceOrder.firstIndex(
                    of: view.word(layout.historyNibbles + 4 * i, 3))
            else { continue }
            let direction = view.word(layout.historyNibbles + 3 + 4 * i, 1)
            injectMissedMove(
                GanMove(
                    serial: (startSerial - i) & 0xff, timestamp: timestamp, localTimestamp: nil,
                    cubeTimestamp: nil, face: face, direction: direction,
                    move: moveName(face, direction)))
        }
        let released = evictMoveBuffer(nil)
        afterHistory(connection, released: released)
        return released
    }

    /// A facelet report: also the moment a gap at the end of a burst gets noticed.
    func handleFacelets(
        _ view: MessageView, serialAt: Int, pieces: (cp: Int, co: Int, ep: Int, eo: Int),
        _ timestamp: Double, _ connection: DriverConnection
    ) -> [GanEvent] {
        serial = view.word(serialAt, 16, littleEndian: true)
        if lastSerial != -1, let last = lastLocalTimestamp, timestamp - last > 500 {
            checkIfMoveMissed(connection)
        }
        if lastSerial == -1 { lastSerial = serial }
        let cp = (0..<7).map { view.word(pieces.cp + $0 * 3, 3) }
        let co = (0..<7).map { view.word(pieces.co + $0 * 2, 2) }
        let ep = (0..<11).map { view.word(pieces.ep + $0 * 4, 4) }
        let eo = (0..<11).map { view.word(pieces.eo + $0, 1) }
        return GanFacelets.report(serial: serial, timestamp: timestamp, cp: cp, co: co, ep: ep, eo: eo)
            .map { [$0] } ?? []
    }
}

// MARK: - Gen3

/// GAN356 i Carry 2. Framed: a `0x55` magic byte, a type and a length.
final class Gen3Driver: BufferedMoveDriver, GanDriver {
    private static let layout = Layout(
        cubeTimestamp: 24, serial: 56, direction: 72, face: 74, historyStart: 24, historyNibbles: 32)

    func command(_ command: GanCommand) -> [UInt8]? {
        switch command {
        case .requestFacelets: message(size: 16, prefix: [0x68, 0x01])
        case .requestHardware: message(size: 16, prefix: [0x68, 0x04])
        case .requestBattery: message(size: 16, prefix: [0x68, 0x07])
        case .requestReset:
            message(size: 16, prefix: [0x68, 0x05, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab])
        }
    }

    override func requestMoveHistory(_ connection: DriverConnection, serial: Int, count: Int) {
        let window = alignHistoryWindow(serial, count)
        connection.send(message(size: 16, prefix: [0x68, 0x03, UInt8(truncatingIfNeeded: window.serial), 0, UInt8(truncatingIfNeeded: window.count), 0]))
    }

    func handle(_ bytes: [UInt8], connection: DriverConnection) -> [GanEvent] {
        let timestamp = now()
        let view = MessageView(bytes)
        let dataLength = view.word(16, 8)
        guard view.word(0, 8) == 0x55, dataLength != 0 else { return [] }

        switch view.word(8, 8) {
        case 0x01:
            return handleMove(view, Self.layout, timestamp, connection)
        case 0x06:
            return handleHistory(view, Self.layout, dataLength, timestamp, connection)
        case 0x02:
            return handleFacelets(
                view, serialAt: 24, pieces: (cp: 40, co: 61, ep: 77, eo: 121), timestamp, connection)
        case 0x07:
            let name = String((0..<5).map { character(view.word($0 * 8 + 32, 8)) })
            return [
                .hardware(
                    GanHardware(
                        timestamp: timestamp, hardwareName: name,
                        hardwareVersion: "\(view.word(80, 4)).\(view.word(84, 4))",
                        softwareVersion: "\(view.word(72, 4)).\(view.word(76, 4))",
                        productDate: nil, gyroSupported: false))
            ]
        case 0x10:
            return [.battery(timestamp: timestamp, level: min(view.word(24, 8), 100))]
        case 0x11:
            connection.disconnect()
            return []
        default:
            return []
        }
    }
}

// MARK: - Gen4

/// GAN12 ui Maglev, GAN14 ui FreePlay, GAN i Carry 4. Gen3 without the magic byte, with hardware
/// information split across four messages that are collected before anything is reported.
final class Gen4Driver: BufferedMoveDriver, GanDriver {
    private static let layout = Layout(
        cubeTimestamp: 16, serial: 48, direction: 64, face: 66, historyStart: 16, historyNibbles: 24)

    private static let productDate = 0xfa, name = 0xfc, software = 0xfd, hardwareVersion = 0xfe
    /// The only Gen4 cube with a gyroscope. The i Carry 4 in particular has none.
    private static let gyroModels = ["GAN12uiM"]

    private var hardware: [Int: String] = [:]

    func command(_ command: GanCommand) -> [UInt8]? {
        switch command {
        case .requestFacelets: return message(size: 20, prefix: [0xdd, 0x04, 0x00, 0xed, 0x00, 0x00])
        case .requestHardware:
            // Reset first: the reply is four messages and a stale partial set would report early.
            hardware = [:]
            return message(size: 20, prefix: [0xdf, 0x03, 0x00, 0x00, 0x00])
        case .requestBattery: return message(size: 20, prefix: [0xdd, 0x04, 0x00, 0xef, 0x00, 0x00])
        case .requestReset:
            return message(size: 20, prefix: [0xd2, 0x0d, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab])
        }
    }

    override func requestMoveHistory(_ connection: DriverConnection, serial: Int, count: Int) {
        let window = alignHistoryWindow(serial, count)
        connection.send(message(size: 20, prefix: [0xd1, 0x04, UInt8(truncatingIfNeeded: window.serial), 0, UInt8(truncatingIfNeeded: window.count), 0]))
    }

    func handle(_ bytes: [UInt8], connection: DriverConnection) -> [GanEvent] {
        let timestamp = now()
        let view = MessageView(bytes)
        let eventType = view.word(0, 8)
        let dataLength = view.word(8, 8)

        switch eventType {
        case 0x01:
            return handleMove(view, Self.layout, timestamp, connection)
        case 0xd1:
            return handleHistory(view, Self.layout, dataLength, timestamp, connection)
        case 0xed:
            return handleFacelets(
                view, serialAt: 16, pieces: (cp: 32, co: 53, ep: 69, eo: 113), timestamp, connection)
        case Self.productDate...Self.hardwareVersion:
            collectHardware(eventType, dataLength, view)
            guard hardware.count == 4 else { return [] }
            let name = hardware[Self.name]!
            return [
                .hardware(
                    GanHardware(
                        timestamp: timestamp, hardwareName: name,
                        hardwareVersion: hardware[Self.hardwareVersion]!,
                        softwareVersion: hardware[Self.software]!,
                        productDate: hardware[Self.productDate]!,
                        gyroSupported: Self.gyroModels.contains(name)))
            ]
        case 0xec:
            return [
                .gyro(
                    GanGyro(
                        timestamp: timestamp,
                        quaternion: (
                            x: signed15(view.word(32, 16)), y: signed15(view.word(48, 16)),
                            z: signed15(view.word(64, 16)), w: signed15(view.word(16, 16))
                        ),
                        velocity: (
                            x: signed3(view.word(80, 4)), y: signed3(view.word(84, 4)),
                            z: signed3(view.word(88, 4))
                        )))
            ]
        case 0xef:
            // The level sits past the declared payload, not inside it.
            return [.battery(timestamp: timestamp, level: min(view.word(8 + dataLength * 8, 8), 100))]
        case 0xea:
            connection.disconnect()
            return []
        default:
            return []
        }
    }

    private func collectHardware(_ eventType: Int, _ dataLength: Int, _ view: MessageView) {
        switch eventType {
        case Self.productDate:
            let year = view.word(24, 16, littleEndian: true)
            hardware[eventType] =
                "\(padded(year, 4))-\(padded(view.word(40, 8), 2))-\(padded(view.word(48, 8), 2))"
        case Self.name:
            hardware[eventType] = String(
                stride(from: 0, to: dataLength - 1, by: 1).map { character(view.word($0 * 8 + 24, 8)) })
        case Self.software, Self.hardwareVersion:
            hardware[eventType] = "\(view.word(24, 4)).\(view.word(28, 4))"
        default:
            break
        }
    }
}
