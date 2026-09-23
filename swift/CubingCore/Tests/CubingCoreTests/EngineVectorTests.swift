import XCTest
@testable import CubingCore

/// The Swift engine against the recorded TypeScript.
///
/// This is the whole point of S0's oracle: 3,000 cases covering move application, notation
/// round-trips and orientation, recorded from the implementation that has 771 tests behind it. A
/// failure here is not "a test disagrees", it is "these two implementations of the same cube
/// disagree about a specific position", and the case names the scramble that produced it.
final class EngineVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Case: Decodable {
            let scramble: String
            let facelets: String
            let reserialized: String
            let afterExtra: String
            let `extra`: String
            let normalized: String
            let isStandardOrientation: Bool
            let isSolvedIgnoringOrientation: Bool
        }
        let generator: String
        let cases: [Case]
    }

    static func load(_ name: String) throws -> Data {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CubingCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // CubingCore
            .deletingLastPathComponent()  // swift
            .deletingLastPathComponent()  // repo root
        return try Data(contentsOf: repo.appendingPathComponent("vectors/\(name).json"))
    }

    func testAppliesMovesAsTheTypeScriptDoes() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: Self.load("engine"))
        XCTAssertEqual(vectors.generator, "engine")
        XCTAssertEqual(vectors.cases.count, 3000)

        var checked = 0
        for (i, expected) in vectors.cases.enumerated() {
            let moves = try Notation.parse(expected.scramble)
            let state = CubeState.after(moves)

            XCTAssertEqual(
                Facelets.string(from: state), expected.facelets,
                "case \(i): scramble \"\(expected.scramble)\""
            )

            // Notation must survive a round trip, including the empty sequence.
            XCTAssertEqual(
                Notation.write(moves), expected.reserialized,
                "case \(i): reserializing \"\(expected.scramble)\""
            )

            // The orientation half of the corpus — a third of cases are left rotated, because an
            // earlier version of the oracle had none and hid a bug in exactly this code.
            XCTAssertEqual(
                Facelets.string(from: state.normalized), expected.normalized,
                "case \(i): normalizing \"\(expected.scramble)\""
            )
            XCTAssertEqual(state.isStandardOrientation, expected.isStandardOrientation, "case \(i)")
            XCTAssertEqual(
                state.isSolvedIgnoringOrientation, expected.isSolvedIgnoringOrientation, "case \(i)"
            )
            // And back again: every recorded string must parse to the state that produced it.
            XCTAssertEqual(try Facelets.state(from: expected.facelets), state, "case \(i): parsing")

            // Composition, not just a single apply.
            let extra = try Notation.parse(expected.extra)
            XCTAssertEqual(
                Facelets.string(from: state.applying(extra)), expected.afterExtra,
                "case \(i): \"\(expected.scramble)\" then \"\(expected.extra)\""
            )
            checked += 1
        }
        XCTAssertEqual(checked, 3000)
    }

    func testFaceOrderMatchesTheTypeScript() {
        // `packages/engine/src/state.ts`: { U: 0, L: 1, F: 2, R: 3, B: 4, D: 5 }. Pinned separately
        // because the engine corpus never records a face index and so cannot catch this.
        XCTAssertEqual([Face.u, .l, .f, .r, .b, .d].map(\.rawValue), [0, 1, 2, 3, 4, 5])
    }

    func testThereAreTwentyFourOrientations() {
        XCTAssertEqual(Orientations.path.count, 24)
    }

    func testParsesEveryFamilyTheTablesKnow() throws {
        // Rotations and wide moves matter disproportionately: a third of the corpus is left in a
        // non-standard orientation precisely because an earlier version of the oracle had none,
        // and that gap hid a bug in exactly this area.
        for family in families {
            for modifier in ["", "'", "2"] {
                let text = family + modifier
                let moves = try Notation.parse(text)
                XCTAssertEqual(moves.count, 1, "parsing \(text)")
                XCTAssertEqual(moves[0].family, family, "parsing \(text)")
            }
        }
    }

    func testRejectsWhatTheTypeScriptRejects() {
        // Layer-prefixed moves are big-cube notation the tables do not model. Applying `U` for
        // `2U` would be silently wrong, which is worse than failing.
        XCTAssertThrowsError(try Notation.parse("2U"))
        XCTAssertThrowsError(try Notation.parse("3Rw"))
        XCTAssertThrowsError(try Notation.parse("Q"))
    }

    func testDropsWholeRotationsRatherThanFailing() throws {
        // `R4` is a no-op, and reconstructions do contain them.
        XCTAssertEqual(try Notation.parse("R4").count, 0)
        XCTAssertEqual(try Notation.parse("R R4 U").count, 2)
    }

    func testIgnoresComments() throws {
        // The reconstruction corpus carries `// phase` annotations on every line.
        let moves = try Notation.parse("R U // cross\nF' // first pair")
        XCTAssertEqual(Notation.write(moves), "R U F'")
    }
}
