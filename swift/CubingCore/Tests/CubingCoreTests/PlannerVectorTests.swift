import XCTest
@testable import CubingCore

/// The cross planner against the recorded TypeScript: features, comfort, the committed model's
/// score, and each kept plan as a person would see it — re-framed, with its setup rotation.
final class PlannerVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Awkward: Decodable {
            let back: Int
            let left: Int
        }
        struct Plan: Decodable {
            let text: String
            let searchText: String
            let setup: String
            let down: Int
            let front: Int
            let rotation: String
            let comfort: Double
        }
        struct Case: Decodable {
            let facelets: String
            let face: Int
            let crossMoves: String
            let comfort: Double
            let awkward: Awkward
            let crossFeatures: [Double]
            let modelScore: Double?
            let planCrossLength: Int
            let planCandidates: Int
            let plans: [Plan]
        }
        let generator: String
        let cases: [Case]
    }

    func testPlansAsTheTypeScriptDoes() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("planner"))
        XCTAssertEqual(vectors.generator, "planner")
        XCTAssertEqual(vectors.cases.count, 1200)
        let weights = try XCTUnwrap(Weights.cross, "the cross ranker's weights are missing")

        for (i, expected) in vectors.cases.enumerated() {
            let context = "case \(i): \(expected.facelets) face \(expected.face)"
            let state = try Facelets.state(from: expected.facelets)

            // Pure functions of a move sequence, checked on the recorded cross so a solver
            // difference cannot masquerade as a feature difference.
            let cross = try Notation.parse(expected.crossMoves)
            XCTAssertEqual(Comfort.score(cross), expected.comfort, accuracy: 1e-6, context)
            let awkward = Comfort.awkwardTurns(cross)
            XCTAssertEqual(awkward.back, expected.awkward.back, context)
            XCTAssertEqual(awkward.left, expected.awkward.left, context)
            let features = Features.cross(cross)
            XCTAssertEqual(features.count, expected.crossFeatures.count, context)
            for (actual, want) in zip(features, expected.crossFeatures) {
                XCTAssertEqual(actual, want, accuracy: 1e-6, context)
            }
            if let modelScore = expected.modelScore {
                XCTAssertEqual(weights.score(features), modelScore, accuracy: 1e-6, context)
            }

            let plan = Planner.planCross(state, expected.face)
            XCTAssertEqual(plan.crossLength, expected.planCrossLength, context)
            XCTAssertEqual(plan.cross.count, expected.planCandidates, context)
            for (actual, want) in zip(plan.cross, expected.plans) {
                XCTAssertEqual(Notation.write(actual.searchMoves), want.searchText, context)
                XCTAssertEqual(actual.text, want.text, "\(context): framing \(want.searchText)")
                XCTAssertEqual(Notation.write(actual.setup), want.setup, context)
                XCTAssertEqual(actual.hold.down, want.down, context)
                XCTAssertEqual(actual.hold.front, want.front, context)
                XCTAssertEqual(actual.hold.rotation, want.rotation, context)
                XCTAssertEqual(actual.comfort, want.comfort, accuracy: 1e-6, context)
            }
        }
    }

    func testThereAreFourFramesPerColour() {
        XCTAssertEqual(Orientation.all.count, 24)
        for colour in 0..<6 { XCTAssertEqual(Orientation.withColourDown(colour).count, 4) }
    }

    func testReframingIsTheSameCube() {
        // A re-spelled sequence, executed in its frame, must do to the cube what the original did
        // in the original frame: rotate, apply the renamed moves, rotate back.
        let moves = try! Notation.parse("R U F' L2 D B' M E' S2 x y' z2 Rw")
        for orientation in Orientation.all {
            let original = CubeState.solved.applying(moves)
            let reframed = CubeState.solved
                .applying(orientation.rotation)
                .applying(orientation.rename(moves))
                .applying(orientation.rotation.reversed().map(\.inverted))
            XCTAssertEqual(reframed, original, orientation.text)
        }
    }
}

/// This benchmark reads `vectors/planner.json` from the Mac's disk, so unlike the ones in
/// `CubingBenchmarks` it cannot run on a phone, and it lives here behind an explicit opt-in:
/// `npm run swift-bench`.
let benchmarksEnabled = ProcessInfo.processInfo.environment["CUBING_BENCH"] == "1"
let benchmarkSkipReason = "benchmark: set CUBING_BENCH=1 and build with -c release"

extension PlannerVectorTests {
    /// Printed, not asserted; only meaningful from `swift test -c release`.
    func testBenchmarkCrossOnlySweep() throws {
        try XCTSkipUnless(benchmarksEnabled, benchmarkSkipReason)
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("planner"))
        let states = try vectors.cases.prefix(200).map { try Facelets.state(from: $0.facelets) }
        _ = CrossTables.all()
        let started = DispatchTime.now()
        for state in states { for face in 0..<6 { _ = Planner.planCross(state, face) } }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
        print("swift 200 positions x 6 colours cross-only: \(Int(ms)) ms")

        // The same sweep without presentation, to say where the time goes.
        var options = SearchOptions()
        options.maxSolutions = 200
        let searchStarted = DispatchTime.now()
        for state in states { for face in 0..<6 { _ = enumerateCross(state, face, options) } }
        let searchMs =
            Double(DispatchTime.now().uptimeNanoseconds - searchStarted.uptimeNanoseconds) / 1e6
        print("swift 200 positions x 6 colours, search only: \(Int(searchMs)) ms")
    }
}
