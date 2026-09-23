/// A GAN smart cube over CoreBluetooth.
///
/// Replaces the whole `BleTransport` seam of the TypeScript: that abstraction existed to put two
/// radios — Web Bluetooth and Capacitor's — behind one interface, and a native app has one radio.
/// What it keeps is everything learned getting there (see `ble/capacitor.ts` and `ble/mac.ts`):
///
/// - **The MAC is only in a scan's advertisement.** iOS hides the real address behind a per-app
///   UUID, and the key is derived from the address. So scan, read it from the manufacturer data,
///   and remember it per device — a reconnect by identifier yields no advertisement at all.
/// - **Scan with duplicates.** A later advertisement may carry manufacturer data an earlier one
///   lacked; keep whichever sighting has it.
/// - **Recognise a cube by name prefix or by service**, because some withhold their name.
///
/// Main-actor throughout, with CoreBluetooth delivering on the main queue, so no state is shared
/// across threads. At a cube's rate — tens of notifications a second — that costs nothing.

import CoreBluetooth
import CubingCore
import Dispatch
import Foundation

public struct DiscoveredCube: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let name: String
    public let rssi: Int
    /// Nil until an advertisement carrying manufacturer data has been seen.
    public let mac: String?
}

public enum LinkState: Equatable, Sendable {
    case idle
    case unavailable(String)
    case scanning
    case connecting(String)
    case connected(name: String, protocol: GanProtocol)
    case failed(String)
}

/// Service and characteristic UUIDs per generation, from `ble/gan-uuids.ts`.
///
/// `@unchecked Sendable` because `CBUUID` is not marked `Sendable`, though it is immutable once
/// made; these are built once, never mutated, and only compared.
struct GanServiceProfile: @unchecked Sendable {
    let proto: GanProtocol
    let service: CBUUID
    let command: CBUUID
    let state: CBUUID

    static let all = [
        GanServiceProfile(
            proto: .gen2, service: CBUUID(string: "6e400001-b5a3-f393-e0a9-e50e24dc4179"),
            command: CBUUID(string: "28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4"),
            state: CBUUID(string: "28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4")),
        GanServiceProfile(
            proto: .gen3, service: CBUUID(string: "8653000a-43e6-47b7-9cb0-5fc21d4ae340"),
            command: CBUUID(string: "8653000c-43e6-47b7-9cb0-5fc21d4ae340"),
            state: CBUUID(string: "8653000b-43e6-47b7-9cb0-5fc21d4ae340")),
        GanServiceProfile(
            proto: .gen4, service: CBUUID(string: "00000010-0000-fff7-fff6-fff5fff4fff0"),
            command: CBUUID(string: "0000fff5-0000-1000-8000-00805f9b34fb"),
            state: CBUUID(string: "0000fff6-0000-1000-8000-00805f9b34fb")),
    ]
    static let namePrefixes = ["GAN", "MG", "AiCube"]
}

/// Remembers each cube's MAC by its CoreBluetooth identifier, and which cube was used last.
public struct MacStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func mac(for id: UUID) -> String? { defaults.string(forKey: "gan.mac.\(id.uuidString)") }
    public func remember(_ mac: String, for id: UUID) {
        defaults.set(mac, forKey: "gan.mac.\(id.uuidString)")
        defaults.set(id.uuidString, forKey: "gan.lastCube")
    }
    public var lastCube: UUID? { defaults.string(forKey: "gan.lastCube").flatMap(UUID.init) }
}

/// Collects what a driver asks for while it handles a frame, so the connection can act on it after.
/// Keeps the drivers free of any actor or radio.
private final class Outbox: DriverConnection {
    var messages: [[UInt8]] = []
    var hangUp = false
    func send(_ message: [UInt8]) { messages.append(message) }
    func disconnect() { hangUp = true }
}

/// What the move buffer is costing: how often it had to ask for history, and how long answers took.
public struct LinkStats: Equatable, Sendable {
    public var historyRequests = 0
    public var historyResponses = 0
    /// From the first request of a wait to the response that ended it, most recent last.
    public var answerLatenciesMs: [Double] = []

    public init() {}

    public var medianAnswerMs: Double? {
        guard !answerLatenciesMs.isEmpty else { return nil }
        return answerLatenciesMs.sorted()[answerLatenciesMs.count / 2]
    }
}

/// Raw frames in and commands out, in the committed fixture's format (`ble/capture.ts`) plus a
/// `writes` list — so a session recorded on the phone replays through the TypeScript tooling as-is.
struct FrameRecording: Encodable {
    struct Frame: Encodable {
        let atMs: Double
        let hex: String
    }
    struct Limits: Encodable {
        let maxFrames: Int
        let maxDurationMs: Int
    }
    let format = "cubing-companion.gan-protocol-capture"
    let schemaVersion = 1
    let startedAt: String
    let `protocol`: String
    let service: String
    let stateCharacteristic: String
    let deviceName: String?
    let mac: String
    let macSource: String
    let notes = "Recorded by Cubing Native (iOS). `writes` are encrypted commands sent to the cube."
    let limits = Limits(maxFrames: FrameRecording.maxFrames, maxDurationMs: 300_000)
    var stopReason: String?
    var durationMs: Double = 0
    var frames: [Frame] = []
    var writes: [Frame] = []

    static let maxFrames = 20_000

    static func hex(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef")
        return String(bytes.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 0xF)]] })
    }
}

public struct CubeLinkError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
public final class GanCubeConnection: NSObject, CubeStateSource {
    public var onEvent: ((GanEvent) -> Void)?
    public var onStateChange: ((LinkState) -> Void)?
    public var onDiscovered: (([DiscoveredCube]) -> Void)?

    public private(set) var state: LinkState = .idle {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    public private(set) var discovered: [DiscoveredCube] = []
    public let macStore: MacStore

    private var central: CBCentralManager!
    private var sightings: [UUID: (peripheral: CBPeripheral, cube: DiscoveredCube)] = [:]
    private var scanRequested = false

    private var peripheral: CBPeripheral?
    private var cubeName = "GAN"
    private var mac: String?
    private var profile: GanServiceProfile?
    private var commandCharacteristic: CBCharacteristic?
    private var encrypter: GanEncrypter?
    private var driver: GanDriver?
    private let outbox = Outbox()
    private var waitingForFacelets: [UUID: CheckedContinuation<CubeState, Error>] = [:]
    private var macSource = "advertisement"

    public private(set) var stats = LinkStats()
    private var retryLoop: Task<Void, Never>?
    private var unansweredSince: Double?
    private var recording: FrameRecording?
    private var recordingStart = 0.0
    public var isRecording: Bool { recording != nil }
    /// The most recent finished recording, including one ended by a disconnect.
    public private(set) var lastRecording: URL?

    /// Milliseconds on a monotonic clock — the host side of the timeline fit.
    public static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

    public init(macStore: MacStore = MacStore()) {
        self.macStore = macStore
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    public var lastCube: UUID? { macStore.lastCube }

    // MARK: Scanning

    public func startScan() {
        scanRequested = true
        sightings.removeAll()
        publishDiscovered()
        guard central.state == .poweredOn else { return }
        state = .scanning
        central.scanForPeripherals(
            withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    public func stopScan() {
        scanRequested = false
        if central.isScanning { central.stopScan() }
        if state == .scanning { state = .idle }
    }

    private func publishDiscovered() {
        discovered = sightings.values.map(\.cube).sorted { $0.rssi > $1.rssi }
        onDiscovered?(discovered)
    }

    // MARK: Connecting

    /// Connect to a cube seen in this scan.
    public func connect(_ id: UUID) {
        guard let sighting = sightings[id] else { return }
        stopScan()
        // The advertisement's MAC wins; a remembered one covers a sighting that did not carry it.
        macSource = sighting.cube.mac == nil ? "stored" : "advertisement"
        guard let mac = sighting.cube.mac ?? macStore.mac(for: id) else {
            state = .failed(
                "\(sighting.cube.name) did not advertise its address, so its data cannot be decrypted. Keep scanning a little longer.")
            return
        }
        begin(sighting.peripheral, name: sighting.cube.name, mac: mac)
    }

    /// Reconnect to the last cube without scanning, using its remembered MAC.
    public func reconnect() {
        guard let id = macStore.lastCube, let mac = macStore.mac(for: id),
            let peripheral = central.retrievePeripherals(withIdentifiers: [id]).first
        else { return startScan() }
        macSource = "stored"
        begin(peripheral, name: peripheral.name ?? "GAN", mac: mac)
    }

    private func begin(_ peripheral: CBPeripheral, name: String, mac: String) {
        self.peripheral = peripheral
        self.cubeName = name
        self.mac = mac
        macStore.remember(mac, for: peripheral.identifier)
        peripheral.delegate = self
        state = .connecting(name)
        central.connect(peripheral)
    }

    public func disconnect() {
        guard let peripheral else { return }
        central.cancelPeripheralConnection(peripheral)
    }

    // MARK: Talking

    public func send(_ command: GanCommand) {
        guard let message = driver?.command(command) else { return }
        write(message)
    }

    private func write(_ message: [UInt8]) {
        guard let peripheral, let characteristic = commandCharacteristic, let encrypter else { return }
        let type: CBCharacteristicWriteType =
            characteristic.properties.contains(.write) ? .withResponse : .withoutResponse
        let encrypted = encrypter.encrypt(message)
        if profile?.proto.isHistoryRequest(message) == true {
            stats.historyRequests += 1
            if unansweredSince == nil { unansweredSince = Self.now() }
        }
        recording?.writes.append(.init(atMs: Self.now() - recordingStart, hex: FrameRecording.hex(encrypted)))
        peripheral.writeValue(Data(encrypted), for: characteristic, type: type)
    }

    // MARK: Recording

    /// Start keeping every frame in and command out, for replay through the TypeScript tooling.
    public func startRecording() {
        guard let profile, let mac else { return }
        recordingStart = Self.now()
        recording = FrameRecording(
            startedAt: ISO8601DateFormatter().string(from: Date()), protocol: profile.proto.rawValue,
            service: profile.service.uuidString.lowercased(),
            stateCharacteristic: profile.state.uuidString.lowercased(), deviceName: cubeName, mac: mac,
            macSource: macSource)
    }

    /// Stop, and write the recording to a temporary file to share. Nil if nothing was recording.
    public func stopRecording(reason: String = "manual") -> URL? {
        guard var capture = recording else { return nil }
        recording = nil
        capture.stopReason = reason
        capture.durationMs = Self.now() - recordingStart
        let stamp = capture.startedAt.replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("gan-\(capture.protocol)-capture-\(stamp).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(capture), (try? data.write(to: url)) != nil else { return nil }
        lastRecording = url
        return url
    }

    /// Ask the cube for its state and wait for the facelet report, for up to three seconds.
    public func queryState() async throws -> CubeState {
        guard case .connected = state else { throw CubeLinkError("the cube is not connected") }
        let id = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            waitingForFacelets[id] = continuation
            send(.requestFacelets)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.waitingForFacelets.removeValue(forKey: id)?
                    .resume(throwing: CubeLinkError("the cube did not report its state"))
            }
        }
    }

    private func handle(_ data: Data) {
        guard data.count >= 16, let encrypter, let driver else { return }
        if recording != nil {
            recording!.frames.append(.init(atMs: Self.now() - recordingStart, hex: FrameRecording.hex([UInt8](data))))
            if recording!.frames.count >= FrameRecording.maxFrames { _ = stopRecording(reason: "frame-limit") }
        }
        let plain = encrypter.decrypt([UInt8](data))
        if profile?.proto.isHistoryResponse(plain) == true {
            stats.historyResponses += 1
            if let since = unansweredSince {
                stats.answerLatenciesMs.append(Self.now() - since)
                if stats.answerLatenciesMs.count > 200 { stats.answerLatenciesMs.removeFirst() }
                unansweredSince = nil
            }
        }
        let events = driver.handle(plain, connection: outbox)
        flushOutbox()
        for event in events {
            if case .facelets(let report) = event, let cube = try? Facelets.state(from: report.facelets) {
                for continuation in waitingForFacelets.values { continuation.resume(returning: cube) }
                waitingForFacelets.removeAll()
            }
            onEvent?(event)
        }
    }

    /// Send what the driver asked for while handling a frame or a retry, and hang up if it said to.
    private func flushOutbox() {
        for message in outbox.messages { write(message) }
        outbox.messages.removeAll()
        if outbox.hangUp {
            outbox.hangUp = false
            disconnect()
        }
    }

    /// Eager recovery retries lost moves on a timer, so a dropped answer is asked for again during
    /// a pause rather than waiting a second for the cube's next idle report. See `RecoveryMode`.
    private func startRetrying() {
        retryLoop?.cancel()
        retryLoop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(RecoveryMode.repeatMs * 1_000_000))
                guard let self, let driver = self.driver else { return }
                driver.retry(connection: self.outbox)
                self.flushOutbox()
            }
        }
    }

    private func tearDown(_ reason: String?) {
        retryLoop?.cancel()
        retryLoop = nil
        for continuation in waitingForFacelets.values {
            continuation.resume(throwing: CubeLinkError("the cube disconnected"))
        }
        waitingForFacelets.removeAll()
        if recording != nil { _ = stopRecording(reason: "disconnected") }
        unansweredSince = nil
        peripheral = nil
        profile = nil
        commandCharacteristic = nil
        encrypter = nil
        driver = nil
        state = reason.map(LinkState.failed) ?? .idle
    }
}

// MARK: - CoreBluetooth

// `@preconcurrency`: the delegate protocols predate Swift concurrency and are not isolated, but the
// central is created on the main queue, so every callback does arrive on the main actor. This lets
// the methods stay main-actor isolated, with the runtime checking that promise.

extension GanCubeConnection: @preconcurrency CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if scanRequested { startScan() }
        case .unauthorized:
            state = .unavailable("Bluetooth permission was denied. Allow it in Settings to connect a cube.")
        case .poweredOff:
            state = .unavailable("Bluetooth is turned off.")
        case .unsupported:
            state = .unavailable("This device does not support Bluetooth LE.")
        default:
            break
        }
    }

    public func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi: NSNumber
    ) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let byName = name.map { name in GanServiceProfile.namePrefixes.contains { name.hasPrefix($0) } } ?? false
        let byService = services.contains { uuid in GanServiceProfile.all.contains { $0.service == uuid } }
        guard byName || byService else { return }

        let manufacturer = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data).map { [UInt8]($0) }
        let previous = sightings[peripheral.identifier]?.cube
        let cube = DiscoveredCube(
            id: peripheral.identifier, name: name ?? previous?.name ?? "GAN cube",
            rssi: rssi.intValue == 127 ? (previous?.rssi ?? -100) : rssi.intValue,
            mac: manufacturer.flatMap(Mac.fromManufacturerData) ?? previous?.mac)
        sightings[peripheral.identifier] = (peripheral, cube)
        if cube != previous { publishDiscovered() }
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices(GanServiceProfile.all.map(\.service))
    }

    public func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        tearDown("Could not connect: \(error?.localizedDescription ?? "unknown error")")
    }

    public func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
    ) {
        onEvent?(.disconnect(timestamp: Self.now()))
        tearDown(error.map { "Disconnected: \($0.localizedDescription)" })
    }
}

extension GanCubeConnection: @preconcurrency CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let services = peripheral.services ?? []
        guard
            let profile = GanServiceProfile.all.first(where: { p in services.contains { $0.uuid == p.service } }),
            let service = services.first(where: { $0.uuid == profile.service })
        else {
            state = .failed("This device does not expose a known GAN service, so its protocol is unsupported.")
            return disconnect()
        }
        self.profile = profile
        peripheral.discoverCharacteristics([profile.state, profile.command], for: service)
    }

    public func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard let profile, let characteristics = service.characteristics,
            let stateCharacteristic = characteristics.first(where: { $0.uuid == profile.state }),
            let command = characteristics.first(where: { $0.uuid == profile.command })
        else {
            state = .failed("The cube's characteristics were not found.")
            return disconnect()
        }
        commandCharacteristic = command
        peripheral.setNotifyValue(true, for: stateCharacteristic)
    }

    public func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let profile, let mac, characteristic.isNotifying else {
            state = .failed("The cube refused notifications: \(error?.localizedDescription ?? "unknown")")
            return disconnect()
        }
        do {
            encrypter = try GanEncrypter.forCube(named: cubeName, mac: mac)
        } catch {
            state = .failed("\(error)")
            return disconnect()
        }
        driver = profile.proto.driver(now: Self.now, recovery: .eager)
        state = .connected(name: cubeName, protocol: profile.proto)
        startRetrying()
    }

    public func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        guard characteristic.uuid == profile?.state, let value = characteristic.value else { return }
        handle(value)
    }
}
