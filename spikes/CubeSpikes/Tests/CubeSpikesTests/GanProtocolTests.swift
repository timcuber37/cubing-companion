import XCTest
@testable import CubeSpikes

/// Spike 3, checked against the cube itself.
///
/// `gan-gen4-frames.json` is 1,213 encrypted frames recorded from a real GAN i Carry 4 in P1, and
/// P2 established what they decode to. So this is not "does the Swift compile" — it is whether a
/// Swift port reproduces, byte for byte, what the TypeScript implementation and the reference
/// library both produce from the same hardware capture.
///
/// If these numbers come out right, porting `packages/cube-link/src/gan/` is mechanical.
final class GanProtocolTests: XCTestCase {
    struct Capture: Decodable {
        struct Frame: Decodable { let atMs: Double; let hex: String }
        let mac: String
        let protocolName: String
        let frames: [Frame]

        enum CodingKeys: String, CodingKey {
            case mac
            case protocolName = "protocol"
            case frames
        }
    }

    /// The committed capture, found relative to this file rather than bundled as a resource — the
    /// spike reads the repository's own fixture, not a copy that could drift from it.
    private func loadCapture() throws -> Capture {
        let here = URL(fileURLWithPath: #filePath)
        let repo = here.deletingLastPathComponent()  // CubeSpikesTests
            .deletingLastPathComponent()             // Tests
            .deletingLastPathComponent()             // CubeSpikes
            .deletingLastPathComponent()             // spikes
            .deletingLastPathComponent()             // repo root
        let url = repo
            .appendingPathComponent("packages/cube-link/test/fixtures/gan-gen4-frames.json")
        return try JSONDecoder().decode(Capture.self, from: Data(contentsOf: url))
    }

    private func bytes(_ hex: String) -> [UInt8] {
        stride(from: 0, to: hex.count, by: 2).compactMap {
            let start = hex.index(hex.startIndex, offsetBy: $0)
            let end = hex.index(start, offsetBy: 2)
            return UInt8(hex[start..<end], radix: 16)
        }
    }

    func testDecodesTheRecordedCubeExactly() throws {
        let capture = try loadCapture()
        XCTAssertEqual(capture.protocolName, "gen4")
        XCTAssertEqual(capture.frames.count, 1213)

        let encrypter = GanEncrypter(mac: capture.mac)
        var moves = 0, facelets = 0, battery = 0, other = 0
        var invalidFaces = 0
        var serials: [Int] = []
        var timestamps: [Int] = []
        // Host arrival of the *move* frames specifically. Comparing against the first and last
        // frame of any kind would include the idle heartbeats either side of the turning, which
        // stretches the host span by three seconds and makes a correct decode look wrong.
        var hostTimes: [Double] = []

        for frame in capture.frames {
            switch GanGen4.decode(encrypter.decrypt(bytes(frame.hex))) {
            case .move(let move):
                moves += 1
                if move.face < 0 { invalidFaces += 1 }
                serials.append(move.serial)
                timestamps.append(move.cubeTimestamp)
                hostTimes.append(frame.atMs)
            case .facelets: facelets += 1
            case .battery: battery += 1
            case .other: other += 1
            }
        }

        // The numbers P2 recorded in MOBILE_PLAN.md, reproduced by an independent implementation
        // in a different language. Anything else means the port is not mechanical.
        XCTAssertEqual(moves, 1063, "MOVE frames")
        XCTAssertEqual(facelets, 138, "FACELETS frames")
        XCTAssertEqual(battery, 11, "BATTERY frames")
        XCTAssertEqual(other, 1, "one unrecognised frame, as recorded")
        XCTAssertEqual(invalidFaces, 0, "every move decoded to a real face")

        // The decisive check: the cube's own clock, recovered from the decrypted payload. A wrong
        // key gives noise, and noise does not advance monotonically over two minutes.
        let nonMonotonic = zip(timestamps, timestamps.dropFirst()).filter { $1 < $0 }.count
        XCTAssertEqual(nonMonotonic, 0, "cube timestamps advance monotonically")

        let span = Double(timestamps.last! - timestamps.first!) / 1000
        let hostSpan = (hostTimes.last! - hostTimes.first!) / 1000
        XCTAssertEqual(span / hostSpan, 1.0, accuracy: 0.01,
                       "cube clock tracks the host clock over \(hostSpan.rounded()) s")
    }

    func testSerialsAreEightBitAsTheCaptureShowed() throws {
        // P2 found the reference reads a 16-bit little-endian word here and gets away with it only
        // because the high byte is always zero. Worth re-confirming from Swift, since a port that
        // assumed 16 bits would inherit a latent bug rather than a working one.
        let capture = try loadCapture()
        let encrypter = GanEncrypter(mac: capture.mac)

        var highBytesSet = 0
        for frame in capture.frames {
            let message = encrypter.decrypt(bytes(frame.hex))
            guard GanMessageView(message).word(0, 8) == 0x01 else { continue }
            if message[7] != 0 { highBytesSet += 1 }
        }
        XCTAssertEqual(highBytesSet, 0, "the serial's high byte is zero across every move frame")
    }
}
