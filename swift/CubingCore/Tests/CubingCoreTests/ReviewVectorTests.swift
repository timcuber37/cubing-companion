import XCTest
@testable import CubingCore

/// The decision diff, "which pair next" and the replay grip against the recorded TypeScript, over
/// the twenty real reconstructions in `vectors/review.json`, with the model weights the app ships.
final class ReviewVectorTests: XCTestCase {
    struct Case: Decodable {
        struct GripCase: Decodable {
            let rotation: String
            let firstTurn: Int
            let moveText: [String]
        }
        struct NextPairsCase: Decodable {
            let at: Int
            let crossFace: Int?
            let ranked: [RankedPair]
            let learned: Bool
        }
        let id: Int
        let scramble: String
        let solution: String
        let crossFace: Int
        let grip: GripCase
        let diff: SolveDiff
        let nextPairs: [NextPairsCase]
    }

    struct Vectors: Decodable {
        let generator: String
        let cases: [Case]
    }

    static let vectors: Vectors = {
        try! JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("review"))
    }()

    func testReviewsSolvesAsTheTypeScriptDoes() throws {
        XCTAssertEqual(Self.vectors.generator, "review")
        XCTAssertEqual(Self.vectors.cases.count, 20)
        var decisions = 0
        for c in Self.vectors.cases {
            let context = "reconstruction \(c.id)"
            let start = CubeState.after(try Notation.parse(c.scramble))
            let solution = try Notation.parse(c.solution)
            let diff = try XCTUnwrap(Review.diff(start, solution), context)

            XCTAssertEqual(diff.learned, c.diff.learned, context)
            XCTAssertEqual(diff.failure, c.diff.failure, context)
            assertSame(diff.cross, c.diff.cross, context)
            XCTAssertEqual(diff.pairs.count, c.diff.pairs.count, context)
            for (a, e) in zip(diff.pairs, c.diff.pairs) {
                decisions += 1
                let where_ = "\(context), pair step \(e.step)"
                XCTAssertEqual(a.step, e.step, where_)
                XCTAssertEqual(a.at, e.at, where_)
                XCTAssertEqual(a.yours, e.yours, where_)
                XCTAssertEqual(a.theirs, e.theirs, where_)
                XCTAssertEqual(a.wording, e.wording, where_)
                XCTAssertEqual(a.reasons, e.reasons, where_)
                XCTAssertEqual(a.playedTurns, e.playedTurns, where_)
                XCTAssertEqual(a.optimalTurns, e.optimalTurns, where_)
                XCTAssertEqual(a.played, e.played, where_)
                XCTAssertEqual(a.branch, e.branch, where_)
                XCTAssertEqual(a.lookahead?.label, e.lookahead?.label, where_)
                XCTAssertEqual(a.lookahead?.forecast, e.lookahead?.forecast, where_)
                XCTAssertEqual(a.options.count, e.options.count, where_)
                for (x, y) in zip(a.options, e.options) {
                    XCTAssertEqual(x.slot, y.slot, where_)
                    XCTAssertEqual(x.label, y.label, where_)
                    XCTAssertEqual(x.optimal, y.optimal, where_)
                    XCTAssertEqual(x.setup, y.setup, where_)
                    XCTAssertEqual(x.moves, y.moves, where_)
                    XCTAssertEqual(x.mine, y.mine, where_)
                    XCTAssertEqual(x.confidence, y.confidence, accuracy: 1e-9, where_)
                }
            }
        }
        XCTAssertGreaterThan(decisions, 30)
    }

    func testInfersTheGripAsTheTypeScriptDoes() throws {
        for c in Self.vectors.cases {
            let start = CubeState.after(try Notation.parse(c.scramble))
            let solution = try Notation.parse(c.solution)
            let spans = try XCTUnwrap(Segmentation.segment(from: start, solution: solution).segmentation?.spans)
            let firstTurn = min(solution.firstIndex { !Segmentation.isRotation($0) } ?? 0, solution.count)
            XCTAssertEqual(firstTurn, c.grip.firstTurn, "reconstruction \(c.id)")
            let atFirstTurn = start.applying(Array(solution[0..<firstTurn]))
            let grip = Grip.infer(
                Grip.observations(spans),
                Grip.framesPuttingColourDown(atFirstTurn.centers.map(Int.init), c.crossFace))
            XCTAssertEqual(grip.text, c.grip.rotation, "reconstruction \(c.id)")
            XCTAssertEqual(solution.map { Notation.write(grip.rename([$0])) }, c.grip.moveText, "reconstruction \(c.id)")
        }
    }

    func testRanksTheNextPairAsTheTypeScriptDoes() throws {
        var positions = 0
        for c in Self.vectors.cases {
            let start = CubeState.after(try Notation.parse(c.scramble))
            let solution = try Notation.parse(c.solution)
            for expected in c.nextPairs {
                positions += 1
                let context = "reconstruction \(c.id) at move \(expected.at)"
                let actual = Review.nextPairs(start.applying(Array(solution[0..<expected.at])))
                XCTAssertEqual(actual.crossFace, expected.crossFace, context)
                XCTAssertEqual(actual.learned, expected.learned, context)
                XCTAssertEqual(actual.ranked.map(\.slot), expected.ranked.map(\.slot), context)
                for (a, e) in zip(actual.ranked, expected.ranked) {
                    XCTAssertEqual(a.label, e.label, context)
                    XCTAssertEqual(a.optimal, e.optimal, context)
                    XCTAssertEqual(a.moves, e.moves, context)
                    XCTAssertEqual(a.lookahead, e.lookahead, context)
                    XCTAssertEqual(a.confidence, e.confidence, accuracy: 1e-9, context)
                }
            }
        }
        XCTAssertEqual(positions, 40)
    }

    private func assertSame(_ a: CrossDiff?, _ e: CrossDiff?, _ context: String) {
        XCTAssertEqual(a == nil, e == nil, context)
        guard let a, let e else { return }
        XCTAssertEqual(a.at, e.at, context)
        XCTAssertEqual(a.end, e.end, context)
        XCTAssertEqual(a.playedTurns, e.playedTurns, context)
        XCTAssertEqual(a.optimalTurns, e.optimalTurns, context)
        XCTAssertEqual(a.setup, e.setup, "\(context): cross setup")
        XCTAssertEqual(a.best, e.best, "\(context): best cross")
        XCTAssertEqual(a.hold, e.hold, context)
        XCTAssertEqual(a.branch, e.branch, context)
        XCTAssertEqual(a.lookahead?.label, e.lookahead?.label, context)
        XCTAssertEqual(a.lookahead?.turns, e.lookahead?.turns, context)
        XCTAssertEqual(a.lookahead?.branch, e.lookahead?.branch, "\(context): opening")
    }
}
