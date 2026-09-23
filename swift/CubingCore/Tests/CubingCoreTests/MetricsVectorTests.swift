import XCTest
@testable import CubingCore

/// Metrics and scoring against the recorded TypeScript, over twenty real reconstructions in three
/// synthetic timing profiles each: steady, a slow start, and one long mid-solve pause.
///
/// This is also the only corpus that segments *real* solves — wide moves, rotations, `D D`
/// written long — so it doubles as a second, harder check on the analysis port.
final class MetricsVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct PhaseCase: Decodable {
            let phase: String
            let turns: Int
            let durationMs: Double?
            let tps: Double?
            let recognitionMs: Double?
            let pausedMs: Double
        }
        struct Component: Decodable {
            let label: String
            let value: Double
            let rating: Double
        }
        struct Case: Decodable {
            let id: Int
            let profile: Int
            let scramble: String
            let solution: String
            let timestamps: [Double?]
            let phases: [PhaseCase]
            let durationMs: Double?
            let tps: Double?
            let pauses: Int
            let pausedMs: Double
            let longestPauseMs: Double
            let fluidity: Double?
            let medianGapMs: Double?
            let pauseThresholdMs: Double
            let components: [Component]
        }
        let generator: String
        let cases: [Case]
    }

    /// Matches the generator's rounding to six places, so a float that differs only in its last
    /// bits compares equal and anything more does not.
    func assertClose(
        _ actual: Double?, _ expected: Double?, _ context: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        switch (actual, expected) {
        case (nil, nil): return
        case let (a?, e?):
            XCTAssertEqual(a, e, accuracy: 1e-6, context, file: file, line: line)
        default:
            XCTFail("\(context): \(String(describing: actual)) != \(String(describing: expected))",
                file: file, line: line)
        }
    }

    func testMeasuresAndScoresAsTheTypeScriptDoes() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("metrics"))
        XCTAssertEqual(vectors.generator, "metrics")
        XCTAssertGreaterThanOrEqual(vectors.cases.count, 50)

        for expected in vectors.cases {
            let context = "reconstruction \(expected.id), profile \(expected.profile)"
            let result = Segmentation.segment(
                scramble: try Notation.parse(expected.scramble),
                solution: try Notation.parse(expected.solution))
            let spans = try XCTUnwrap(result.segmentation?.spans, "\(context): did not segment")

            let metrics = Metrics.compute(spans, expected.timestamps)
            XCTAssertEqual(metrics.phases.map(\.phase.rawValue), expected.phases.map(\.phase), context)
            for (actual, want) in zip(metrics.phases, expected.phases) {
                let where_ = "\(context), \(want.phase)"
                XCTAssertEqual(actual.turns, want.turns, where_)
                assertClose(actual.durationMs, want.durationMs, "\(where_) duration")
                assertClose(actual.tps, want.tps, "\(where_) tps")
                assertClose(actual.recognitionMs, want.recognitionMs, "\(where_) recognition")
                assertClose(actual.pausedMs, want.pausedMs, "\(where_) paused")
            }
            assertClose(metrics.durationMs, expected.durationMs, "\(context) duration")
            assertClose(metrics.tps, expected.tps, "\(context) tps")
            XCTAssertEqual(metrics.pauses.count, expected.pauses, context)
            assertClose(metrics.pausedMs, expected.pausedMs, "\(context) paused")
            assertClose(metrics.longestPause?.durationMs ?? 0, expected.longestPauseMs, context)
            assertClose(metrics.fluidity, expected.fluidity, "\(context) fluidity")
            assertClose(metrics.medianGapMs, expected.medianGapMs, "\(context) median gap")
            assertClose(metrics.pauseThresholdMs, expected.pauseThresholdMs, "\(context) threshold")

            let score = Scoring.score(metrics)
            XCTAssertEqual(score.components.map(\.label), expected.components.map(\.label), context)
            for (actual, want) in zip(score.components, expected.components) {
                assertClose(actual.rated.value, want.value, "\(context) \(want.label) value")
                assertClose(actual.rated.rating, want.rating, "\(context) \(want.label) rating")
            }
        }
    }

    func testRoundsHalvesUpAsJavaScriptDoes() {
        // Swift's default rounding is half-away-from-zero; `Math.round` is half-up. They differ
        // only on negative halves, which a clamped rating never produces — pinned regardless.
        XCTAssertEqual(Scoring.jsRound(2.5), 3)
        XCTAssertEqual(Scoring.jsRound(-2.5), -2)
    }

    func testBandsFluidity() {
        XCTAssertEqual(Scoring.fluidityBand(0.95), "flowing")
        XCTAssertEqual(Scoring.fluidityBand(0.75), "steady")
        XCTAssertEqual(Scoring.fluidityBand(0.1), "stop-start")
        XCTAssertNil(Scoring.fluidityBand(nil))
    }
}
