import XCTest
@testable import CubingCore

/// Cross distance and enumeration against the recorded TypeScript.
///
/// `crossDistance` is the single most load-bearing number in the project — the planner, the diff
/// and the scoring all rest on it — so it is pinned for every case, along with the shape of an
/// optimal-only enumeration: its length, its size, and whether it hit the cap.
final class SolverVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Case: Decodable {
            let facelets: String
            let face: Int
            let distance: Int
            let solutionLength: Int?
            let solutionSolvesCross: Bool?
            let optimal: Int
            let optimalCount: Int
            let truncated: Bool
        }
        let generator: String
        let cases: [Case]
    }

    func testSolvesCrossesAsTheTypeScriptDoes() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("solver"))
        XCTAssertEqual(vectors.generator, "solver")
        XCTAssertEqual(vectors.cases.count, 1200)

        var options = SearchOptions()
        options.maxExtra = 0
        options.maxSolutions = 64

        for (i, expected) in vectors.cases.enumerated() {
            let state = try Facelets.state(from: expected.facelets)
            let context = "case \(i): \(expected.facelets) face \(expected.face)"
            XCTAssertEqual(crossDistance(state, expected.face), expected.distance, context)

            // The moves may legitimately differ — several optimal crosses exist — so what is
            // pinned is that the solution works and how long it is.
            let solution = solveCross(state, expected.face)
            XCTAssertEqual(solution?.count, expected.solutionLength, context)
            if let solution {
                XCTAssertEqual(
                    crossDistance(state.applying(solution), expected.face) == 0,
                    expected.solutionSolvesCross, context)
            }

            let enumerated = enumerateCross(state, expected.face, options)
            XCTAssertEqual(enumerated.optimal, expected.optimal, context)
            XCTAssertEqual(enumerated.candidates.count, expected.optimalCount, context)
            XCTAssertEqual(enumerated.truncated, expected.truncated, context)
        }
    }

    func testTheTableMatchesThePublishedFacts() {
        // Checkable against the outside world: 12P4 × 2⁴ reachable positions, and 8 is God's
        // number for the cross in HTM.
        let table = CrossTables.table(Face.d.rawValue)
        let reachable = table.distance.filter { $0 != CrossTables.unreachable }
        XCTAssertEqual(reachable.count, CrossTables.reachablePositions)
        XCTAssertEqual(reachable.max(), UInt8(CrossTables.maxDistance))
    }

    func testAnAlreadySolvedCrossHasNoSolution() {
        XCTAssertNil(solveCross(.solved, Face.d.rawValue))
        XCTAssertEqual(crossDistance(.solved, Face.u.rawValue), 0)
    }

    func testBuildsAllSixTablesQuickly() {
        // The P5 baseline for the TypeScript: 591 ms on desktop, 2,208 ms on an iPhone 11, both
        // cold. Printed rather than asserted — a timing assertion is a flaky test — and only
        // meaningful from `swift test -c release`.
        let started = DispatchTime.now()
        let tables = CrossTables.all()
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
        XCTAssertEqual(tables.count, 6)
        print("cross tables, six, cold: \(Int(ms)) ms")
    }
}
