import XCTest
@testable import CubingCore

final class S2SolverVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Pair: Decodable { let slot: String; let distance: Int }
        struct Xcross: Decodable {
            let slot: String
            let optimal: Int
            let count: Int
            let truncated: Bool
        }
        struct Case: Decodable {
            struct Respelling: Decodable {
                struct Output: Decodable { let text: String; let rotations: Int }
                let input: String
                let outputs: [Output]
            }
            let facelets: String
            let face: Int
            let pairs: [Pair]
            let xcross: [Xcross]
            let respell: Respelling
            let nextPair: [Xcross]
        }
        let cases: [Case]
    }

    func testPairTablesAndXcrossesMatchTypeScript() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("s2"))
        XCTAssertEqual(vectors.cases.count, 24)
        for (i, expected) in vectors.cases.enumerated() {
            let state = try Facelets.state(from: expected.facelets)
            let slots = geometry[expected.face].slots
            let context = "s2 case \(i), face \(expected.face)"
            let input = try Notation.parse(expected.respell.input)
            for (index, want) in expected.respell.outputs.enumerated() {
                let actual = try XCTUnwrap(Respell.asWide(input, at: index))
                XCTAssertEqual(actual.text, want.text, context)
                XCTAssertEqual(actual.rotations, want.rotations, context)
                XCTAssertEqual(state.applying(input), state.applying(actual.moves), context)
            }
            for (slot, pair) in zip(slots, expected.pairs) {
                XCTAssertEqual(slot.name, pair.slot, context)
                XCTAssertEqual(pairDistance(state, slot), pair.distance, context)
            }
            let results = enumerateAllXcrosses(state, expected.face)
            for ((slot, result), want) in zip(zip(slots, results), expected.xcross) {
                XCTAssertEqual(slot.name, want.slot, context)
                XCTAssertEqual(result.optimal, want.optimal, context)
                XCTAssertEqual(result.candidates.count, want.count, context)
                XCTAssertEqual(result.truncated, want.truncated, context)
                for candidate in result.candidates.prefix(3) {
                    let after = state.normalized.applying(candidate.moves)
                    XCTAssertEqual(crossDistance(after, expected.face), 0, context)
                    XCTAssertTrue(isSlotSolved(after, slot), context)
                }
            }
            let afterCross = state.normalized.applying(solveCross(state, expected.face) ?? [])
            var options = insertionDefaults()
            options.maxNodes = 50_000
            let next = F2L.nextPair(afterCross, expected.face, options: options)
            XCTAssertEqual(next.count, expected.nextPair.count, context)
            for (actual, want) in zip(next, expected.nextPair) {
                XCTAssertEqual(actual.slot.name, want.slot, context)
                XCTAssertEqual(actual.result.optimal, want.optimal, context)
                XCTAssertEqual(actual.result.candidates.count, want.count, context)
                XCTAssertEqual(actual.result.truncated, want.truncated, context)
            }
        }
    }

    func testEveryPairPositionIsReachable() {
        let distances = PairTables.table(geometry[Face.d.rawValue].slots[0])
        XCTAssertEqual(distances.count, PairTables.indexSpace)
        XCTAssertEqual(distances.filter { $0 == PairTables.unreachable }.count, 0)
        XCTAssertEqual(distances.max(), UInt8(PairTables.maxDistance))
    }
}
