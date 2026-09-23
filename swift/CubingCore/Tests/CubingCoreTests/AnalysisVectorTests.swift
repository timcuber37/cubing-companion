import XCTest
@testable import CubingCore

/// Segmentation against the recorded TypeScript: 1,200 cases, half of which solve the cube and
/// segment, half of which do not and must fail for the same reason.
final class AnalysisVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Span: Decodable, Equatable {
            let phase: String
            let start: Int
            let end: Int
        }
        struct Case: Decodable {
            let facelets: String
            let face: Int
            let solution: String
            let cross: String
            let crossBuiltAfterCross: Bool
            let slotsSolvedAfterCross: Int
            let crossFace: Int?
            let xcross: Bool?
            let freePairs: Int?
            let failure: String?
            let phases: [Span]?
        }
        let generator: String
        let cases: [Case]
    }

    func testSegmentsAsTheTypeScriptDoes() throws {
        let vectors = try JSONDecoder().decode(
            Vectors.self, from: EngineVectorTests.load("analysis"))
        XCTAssertEqual(vectors.generator, "analysis")
        XCTAssertEqual(vectors.cases.count, 1200)

        var segmented = 0
        for (i, expected) in vectors.cases.enumerated() {
            let state = try Facelets.state(from: expected.facelets)
            let geometry = CubingCore.geometry[expected.face]

            let afterCross = state.applying(try Notation.parse(expected.cross))
            XCTAssertEqual(
                isCrossBuilt(afterCross, geometry), expected.crossBuiltAfterCross, "case \(i)")
            XCTAssertEqual(
                geometry.slots.filter { isSlotSolved(afterCross, $0) }.count,
                expected.slotsSolvedAfterCross, "case \(i)")

            let result = Segmentation.segment(
                from: state, solution: try Notation.parse(expected.solution))
            let context = "case \(i): \(expected.facelets) solved by \"\(expected.solution)\""
            XCTAssertEqual(result.failure?.rawValue, expected.failure, context)
            XCTAssertEqual(result.segmentation?.crossFace, expected.crossFace, context)
            XCTAssertEqual(result.segmentation?.xcross, expected.xcross, context)
            XCTAssertEqual(result.segmentation?.freePairs, expected.freePairs, context)
            XCTAssertEqual(
                result.segmentation?.spans.map {
                    Vectors.Span(phase: $0.phase.rawValue, start: $0.start, end: $0.end)
                },
                expected.phases, context)
            if result.segmentation != nil { segmented += 1 }
        }
        // A corpus of failures would pass this test while exercising nothing.
        XCTAssertGreaterThan(segmented, 500)
    }

    func testEachFaceHasFourSlotsAndFourCrossEdges() {
        for g in geometry {
            XCTAssertEqual(g.slots.count, 4)
            XCTAssertEqual(g.crossEdges.count, 4)
            XCTAssertEqual(g.f2lEdges.count, 8)
            XCTAssertEqual(g.llCorners.count, 4)
        }
        // White (D) cross slots, in corner order DFR, DLF, DBL, DRB.
        XCTAssertEqual(geometry[Face.d.rawValue].slots.map(\.name), ["FR", "FL", "BL", "BR"])
    }

    func testSegmentsASolvedCubeAsAllSkips() throws {
        let result = Segmentation.segment(scramble: [], solution: [])
        XCTAssertNil(result.failure)
        XCTAssertEqual(result.segmentation?.skips.count, 8)
    }
}
