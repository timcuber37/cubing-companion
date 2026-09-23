/// GAN protocol primitives: the bit reader, encryption, events and facelet conversion.
///
/// Ported from `packages/cube-link/src/gan/` — `message.ts`, `crypto.ts`, `events.ts` and
/// `facelets.ts` — which were themselves vendored from `gan-web-bluetooth` (MIT, Andy Fedotov). The
/// reasoning behind each quirk (the `% 0xFF` salt, back-to-front decryption, dropping invalid
/// states rather than throwing) is in those files; the comments here only mark where it applies.

import CommonCrypto

// MARK: - Bits

/// Reads bit-packed fields, most significant bit first. Bytes past the end read as zero, exactly
/// as the TypeScript's `?? 0` does — some decoders read past a short message, and what they see
/// there is part of the recorded behaviour.
public struct MessageView {
    let bytes: [UInt8]

    public init(_ bytes: [UInt8]) { self.bytes = bytes }

    public func word(_ start: Int, _ length: Int, littleEndian: Bool = false) -> Int {
        if length <= 8 { return bits(start, length) }
        precondition(length == 16 || length == 32, "unsupported bit word length: \(length)")
        let count = length / 8
        var value = 0
        for i in 0..<count {
            let byte = bits(start + i * 8, 8)
            value += byte << (8 * (littleEndian ? i : count - 1 - i))
        }
        return value
    }

    private func bits(_ start: Int, _ length: Int) -> Int {
        var value = 0
        for i in 0..<length {
            let bit = start + i
            let index = bit >> 3
            let byte = index < bytes.count ? Int(bytes[index]) : 0
            value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1)
        }
        return value
    }
}

// MARK: - Encryption

public struct GanEncrypter: Sendable {
    public static let ganKey: [UInt8] = [
        0x01, 0x02, 0x42, 0x28, 0x31, 0x91, 0x16, 0x07,
        0x20, 0x05, 0x18, 0x54, 0x42, 0x11, 0x12, 0x53,
    ]
    public static let ganIV: [UInt8] = [
        0x11, 0x03, 0x32, 0x28, 0x21, 0x01, 0x76, 0x27,
        0x20, 0x95, 0x78, 0x14, 0x32, 0x12, 0x02, 0x43,
    ]
    /// The MoYu AI 2023 speaks the same protocol under a different key.
    public static let moyuKey: [UInt8] = [
        0x05, 0x12, 0x02, 0x45, 0x02, 0x01, 0x29, 0x56,
        0x12, 0x78, 0x12, 0x76, 0x81, 0x01, 0x08, 0x03,
    ]
    public static let moyuIV: [UInt8] = [
        0x01, 0x44, 0x28, 0x06, 0x86, 0x21, 0x22, 0x28,
        0x51, 0x05, 0x08, 0x31, 0x82, 0x02, 0x21, 0x06,
    ]

    private let key: [UInt8]
    private let iv: [UInt8]

    public init(key baseKey: [UInt8], iv baseIV: [UInt8], salt: [UInt8]) {
        precondition(baseKey.count == 16 && baseIV.count == 16 && salt.count == 6)
        var key = baseKey
        var iv = baseIV
        for i in 0..<6 {
            // `% 0xFF`, not `% 0x100`: the firmware wraps the same way.
            key[i] = UInt8((Int(baseKey[i]) + Int(salt[i])) % 0xFF)
            iv[i] = UInt8((Int(baseIV[i]) + Int(salt[i])) % 0xFF)
        }
        self.key = key
        self.iv = iv
    }

    /// The encrypter for a cube, by name. AiCube-branded devices use MoYu's key.
    public static func forCube(named name: String?, mac: String) throws -> GanEncrypter {
        let moyu = name?.hasPrefix("AiCube") == true
        return GanEncrypter(
            key: moyu ? moyuKey : ganKey, iv: moyu ? moyuIV : ganIV, salt: try Mac.salt(mac))
    }

    private func crypt(_ block: ArraySlice<UInt8>, encrypt: Bool) -> [UInt8] {
        let input = Array(block)
        var output = [UInt8](repeating: 0, count: 16)
        var moved = 0
        let status = key.withUnsafeBytes { key in
            iv.withUnsafeBytes { iv in
                input.withUnsafeBytes { input in
                    output.withUnsafeMutableBytes { output in
                        CCCrypt(
                            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(0),  // CBC, no padding: every chunk is exactly one block
                            key.baseAddress, kCCKeySizeAES128, iv.baseAddress,
                            input.baseAddress, 16, output.baseAddress, 16, &moved)
                    }
                }
            }
        }
        precondition(status == kCCSuccess && moved == 16, "AES failed: \(status)")
        return output
    }

    /// First 16 bytes, then last 16 — they overlap on a 20-byte message, so order matters.
    public func encrypt(_ data: [UInt8]) -> [UInt8] {
        precondition(data.count >= 16, "a message is at least 16 bytes")
        var result = data
        result.replaceSubrange(0..<16, with: crypt(result[0..<16], encrypt: true))
        if result.count > 16 {
            let tail = result.count - 16
            result.replaceSubrange(tail..., with: crypt(result[tail...], encrypt: true))
        }
        return result
    }

    /// Back to front, the exact reverse of `encrypt`.
    public func decrypt(_ data: [UInt8]) -> [UInt8] {
        precondition(data.count >= 16, "a message is at least 16 bytes")
        var result = data
        if result.count > 16 {
            let tail = result.count - 16
            result.replaceSubrange(tail..., with: crypt(result[tail...], encrypt: false))
        }
        result.replaceSubrange(0..<16, with: crypt(result[0..<16], encrypt: false))
        return result
    }
}

// MARK: - Events

public enum GanCommand: String, Sendable, CaseIterable {
    case requestFacelets = "REQUEST_FACELETS"
    case requestHardware = "REQUEST_HARDWARE"
    case requestBattery = "REQUEST_BATTERY"
    case requestReset = "REQUEST_RESET"
}

public struct GanMove: Equatable, Sendable {
    /// Wraps at 256; a gap means packets were missed.
    public let serial: Int
    public let timestamp: Double
    /// Host clock at arrival; nil for a move recovered from history.
    public let localTimestamp: Double?
    /// The cube's own clock; nil on recovered moves.
    public let cubeTimestamp: Double?
    /// In the protocol's `URFDLB` numbering.
    public let face: Int
    public let direction: Int
    /// `"R"` or `"R'"`.
    public let move: String
}

public struct GanPieces: Equatable, Sendable {
    public let cp: [Int], co: [Int], ep: [Int], eo: [Int]
}

public struct GanFaceletsReport: Equatable, Sendable {
    public let serial: Int
    public let timestamp: Double
    public let facelets: String
    public let state: GanPieces
}

public struct GanGyro: Equatable, Sendable {
    public let timestamp: Double
    public let quaternion: (x: Double, y: Double, z: Double, w: Double)
    public let velocity: (x: Int, y: Int, z: Int)?

    public static func == (a: GanGyro, b: GanGyro) -> Bool {
        a.timestamp == b.timestamp && a.quaternion == b.quaternion && a.velocity?.x == b.velocity?.x
            && a.velocity?.y == b.velocity?.y && a.velocity?.z == b.velocity?.z
    }
}

public struct GanHardware: Equatable, Sendable {
    public let timestamp: Double
    public let hardwareName: String
    public let hardwareVersion: String
    public let softwareVersion: String
    public let productDate: String?
    public let gyroSupported: Bool
}

public enum GanEvent: Equatable, Sendable {
    case move(GanMove)
    case facelets(GanFaceletsReport)
    case gyro(GanGyro)
    case battery(timestamp: Double, level: Int)
    case hardware(GanHardware)
    case disconnect(timestamp: Double)
}

/// Face order in the protocol's own numbering.
let ganFaceNames = Array("URFDLB")

func moveName(_ face: Int, _ direction: Int) -> String {
    String(ganFaceNames[face]) + (direction == 1 ? "'" : "")
}

// MARK: - Facelets

/// GAN's piece arrays to a Kociemba facelet string.
///
/// Note GAN's corner numbering — URF, UFL, ULB, UBR — is Kociemba's, not the engine's, so these
/// maps are not `Facelets.cornerFacelets` and must not be merged with them.
public enum GanFacelets {
    static let corners: [[Int]] = [
        [8, 9, 20], [6, 18, 38], [0, 36, 47], [2, 45, 11],
        [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51],
    ]
    static let edges: [[Int]] = [
        [5, 10], [7, 19], [3, 37], [1, 46], [32, 16], [28, 25],
        [30, 43], [34, 52], [23, 12], [21, 41], [50, 39], [48, 14],
    ]

    /// Do these arrays describe a real cube? A corrupted notification is dropped, not trusted.
    public static func isCube(_ p: GanPieces) -> Bool {
        func permutation(_ values: [Int], _ size: Int) -> Bool {
            values.count == size && Set(values).count == size && values.allSatisfy { (0..<size).contains($0) }
        }
        func orientation(_ values: [Int], _ size: Int, _ limit: Int) -> Bool {
            values.count == size && values.allSatisfy { (0..<limit).contains($0) }
        }
        return permutation(p.cp, 8) && orientation(p.co, 8, 3) && permutation(p.ep, 12)
            && orientation(p.eo, 12, 2)
    }

    /// The eighth corner and twelfth edge are implied, not transmitted.
    static func complete(cp: [Int], co: [Int], ep: [Int], eo: [Int]) -> GanPieces {
        GanPieces(
            cp: cp + [28 - cp.reduce(0, +)],
            co: co + [(3 - co.reduce(0, +) % 3) % 3],
            ep: ep + [66 - ep.reduce(0, +)],
            eo: eo + [(2 - eo.reduce(0, +) % 2) % 2])
    }

    public static func string(_ p: GanPieces) -> String {
        let faces = Array("URFDLB")
        var out = (0..<54).map { faces[$0 / 9] }
        for i in 0..<8 {
            for k in 0..<3 {
                out[corners[i][(k + p.co[i]) % 3]] = faces[corners[p.cp[i]][k] / 9]
            }
        }
        for i in 0..<12 {
            for k in 0..<2 {
                out[edges[i][(k + p.eo[i]) % 2]] = faces[edges[p.ep[i]][k] / 9]
            }
        }
        return String(out)
    }

    /// A facelet event, or nil if the cube did not describe a cube.
    static func report(
        serial: Int, timestamp: Double, cp: [Int], co: [Int], ep: [Int], eo: [Int]
    ) -> GanEvent? {
        let pieces = complete(cp: cp, co: co, ep: ep, eo: eo)
        guard isCube(pieces) else { return nil }
        return .facelets(
            GanFaceletsReport(
                serial: serial, timestamp: timestamp, facelets: string(pieces), state: pieces))
    }
}

// MARK: - MAC addresses

public enum Mac {
    public struct InvalidMac: Error, CustomStringConvertible {
        public let description: String
    }

    /// `AB:CD:EF:01:23:45`, uppercase — the form the cube's key is derived from.
    public static func format(_ bytes: [UInt8]) -> String {
        bytes.map { byte in
            let digits = Array("0123456789ABCDEF")
            return String([digits[Int(byte >> 4)], digits[Int(byte & 0xF)]])
        }.joined(separator: ":")
    }

    public static func parse(_ text: String) -> [UInt8]? {
        let parts = text.split(whereSeparator: { $0 == ":" || $0 == "-" || $0 == " " })
        guard parts.count == 6 else { return nil }
        var bytes: [UInt8] = []
        for part in parts {
            guard part.count == 2, let byte = UInt8(part, radix: 16) else { return nil }
            bytes.append(byte)
        }
        return bytes
    }

    /// Six salt bytes, least significant first — the order the address goes over the air.
    static func salt(_ mac: String) throws -> [UInt8] {
        guard let bytes = parse(mac) else {
            throw InvalidMac(description: "\"\(mac)\" is not a MAC address")
        }
        return bytes.reversed()
    }

    /// The MAC hidden in a GAN advertisement, from CoreBluetooth's raw manufacturer data.
    ///
    /// iOS hides the real address behind a per-app identifier, so this is the *only* way to learn
    /// it, and it exists only in a scan's advertisement — a reconnect by identifier has none, which
    /// is why the address has to be remembered. The raw form is the two-byte little-endian company
    /// identifier then the payload; GAN's identifiers all end in `0x01`, and the address is the
    /// payload's last six bytes, reversed.
    public static func fromManufacturerData(_ data: [UInt8]) -> String? {
        guard data.count >= 2, data[0] == 0x01 else { return nil }
        let payload = data[2...]
        guard payload.count >= 6 else { return nil }
        return format(payload.suffix(6).reversed())
    }
}
