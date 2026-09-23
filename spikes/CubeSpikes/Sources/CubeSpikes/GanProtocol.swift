import Foundation
import CommonCrypto

/// Spike 3: does the GAN protocol port cleanly to Swift?
///
/// The question this answers is whether `packages/cube-link/src/gan/` — encryption, the bit
/// reader, the Gen4 driver — is a mechanical port or a research project. It is checked against
/// `vectors`-adjacent data the project already has: `gan-gen4-frames.json`, 1,213 encrypted frames
/// captured from a real GAN i Carry 4, whose correct decode is known (1,063 MOVE, 138 FACELETS,
/// 11 BATTERY, zero invalid face encodings).
///
/// Deliberately not a faithful port — only enough of the Gen4 driver to decrypt a frame and read a
/// move out of it. A spike that reimplemented everything would answer the question by doing the
/// work the question was meant to size.
///
/// **CryptoKit does not do AES-CBC.** It offers GCM, ChaCha20-Poly1305 and key wrapping; CBC is
/// not in its public API. `CommonCrypto` is, it is a system framework with no dependency to add,
/// and the scheme here is single-block anyway. Worth recording, because "use CryptoKit" was the
/// assumption in the plan and it is wrong.

public struct GanEncrypter {
    private let key: [UInt8]
    private let iv: [UInt8]

    /// GAN's shared key and IV, salted per device with the cube's MAC.
    private static let baseKey: [UInt8] = [
        0x01, 0x02, 0x42, 0x28, 0x31, 0x91, 0x16, 0x07,
        0x20, 0x05, 0x18, 0x54, 0x42, 0x11, 0x12, 0x53,
    ]
    private static let baseIV: [UInt8] = [
        0x11, 0x03, 0x32, 0x28, 0x21, 0x01, 0x76, 0x27,
        0x20, 0x95, 0x78, 0x14, 0x32, 0x12, 0x02, 0x43,
    ]

    /// - Parameter mac: `AB:CD:EF:01:23:45`, as the advertisement reports it.
    public init(mac: String) {
        // Reversed: the address is salted in the order it goes over the air, not as printed.
        let salt = mac.split(separator: ":").compactMap { UInt8($0, radix: 16) }.reversed()
        var key = Self.baseKey
        var iv = Self.baseIV
        for (i, byte) in salt.enumerated() {
            // `% 0xFF`, not `% 0x100`. Matches the firmware; anything more correct fails to decrypt.
            key[i] = UInt8((Int(Self.baseKey[i]) + Int(byte)) % 0xFF)
            iv[i] = UInt8((Int(Self.baseIV[i]) + Int(byte)) % 0xFF)
        }
        self.key = key
        self.iv = iv
    }

    /// One 16-byte block, CBC with the fixed IV and no padding.
    private func crypt(_ block: ArraySlice<UInt8>, encrypt: Bool) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 16)
        var moved = 0
        let input = Array(block)
        _ = key.withUnsafeBytes { keyBytes in
            iv.withUnsafeBytes { ivBytes in
                input.withUnsafeBytes { inBytes in
                    out.withUnsafeMutableBytes { outBytes in
                        CCCrypt(
                            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(0),  // no padding: every chunk is exactly one block
                            keyBytes.baseAddress, kCCKeySizeAES128,
                            ivBytes.baseAddress,
                            inBytes.baseAddress, 16,
                            outBytes.baseAddress, 16,
                            &moved
                        )
                    }
                }
            }
        }
        return out
    }

    /// Decrypt back-to-front: the two chunks overlap on a 20-byte frame and order matters.
    public func decrypt(_ data: [UInt8]) -> [UInt8] {
        guard data.count >= 16 else { return data }
        var result = data
        if result.count > 16 {
            let offset = result.count - 16
            result.replaceSubrange(offset..<result.count, with: crypt(result[offset...], encrypt: false))
        }
        result.replaceSubrange(0..<16, with: crypt(result[0..<16], encrypt: false))
        return result
    }
}

/// Reads bit-packed fields, most significant bit first. GAN's messages are not byte-aligned.
public struct GanMessageView {
    private let bytes: [UInt8]
    public init(_ bytes: [UInt8]) { self.bytes = bytes }

    public func word(_ start: Int, _ length: Int, littleEndian: Bool = false) -> Int {
        if length <= 8 { return bits(start, length) }
        let byteCount = length / 8
        var value = 0
        for i in 0..<byteCount {
            let byte = bits(start + i * 8, 8)
            let shift = 8 * (littleEndian ? i : byteCount - 1 - i)
            value += byte << shift
        }
        return value
    }

    private func bits(_ start: Int, _ length: Int) -> Int {
        var value = 0
        for i in 0..<length {
            let bit = start + i
            let byte = bit >> 3 < bytes.count ? bytes[bit >> 3] : 0
            value = (value << 1) | Int((byte >> (7 - UInt8(bit & 7))) & 1)
        }
        return value
    }
}

public struct GanMove {
    public let serial: Int
    public let cubeTimestamp: Int
    public let face: Int
    public let direction: Int
    /// `"R"` or `"R'"`.
    public var notation: String {
        let faces = Array("URFDLB")
        return String(faces[face]) + (direction == 1 ? "'" : "")
    }
}

public enum GanEvent {
    case move(GanMove)
    case facelets(serial: Int)
    case battery(level: Int)
    case other(type: Int)
}

/// Just enough of the Gen4 driver to answer the spike's question.
public enum GanGen4 {
    /// One-hot face encoding, in the protocol's own order.
    private static let moveFaceOrder = [2, 32, 8, 1, 16, 4]

    public static func decode(_ message: [UInt8]) -> GanEvent {
        let view = GanMessageView(message)
        let type = view.word(0, 8)
        let dataLength = view.word(8, 8)

        switch type {
        case 0x01:
            let cubeTimestamp = view.word(16, 32, littleEndian: true)
            let serial = view.word(48, 16, littleEndian: true)
            let direction = view.word(64, 2)
            let face = moveFaceOrder.firstIndex(of: view.word(66, 6)) ?? -1
            return .move(GanMove(serial: serial, cubeTimestamp: cubeTimestamp,
                                 face: face, direction: direction))
        case 0xED:
            return .facelets(serial: view.word(16, 16, littleEndian: true))
        case 0xEF:
            return .battery(level: min(view.word(8 + dataLength * 8, 8), 100))
        default:
            return .other(type: type)
        }
    }
}
