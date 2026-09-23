import XCTest
@testable import CubingCore

final class S2PlannerVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Step: Decodable { let label: String; let text: String }
        struct Plan: Decodable {
            let kind: String
            let slot: String?
            let searchSlot: String?
            let slotLabel: String?
            let text: String
            let searchText: String
            let setup: String
            let down: Int
            let front: Int
            let rotation: String
            let comfort: Double
            let steps: [Step]?
            let solvedPairLabels: [String]?
        }
        struct Case: Decodable {
            struct Ranking: Decodable {
                let slot: String
                let features: [Double]
                let modelScore: Double?
            }
            let facelets: String
            let face: Int
            let crossLength: Int
            let xcrossLength: Int
            let cross: [Plan]
            let keptXcross: [Plan]
            let crossPlusOne: [Plan]
            let crossPlusTwo: [Plan]
            let pairRanking: [Ranking]
        }
        let cases: [Case]
    }

    func testCompletePlansMatchTypeScript() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: EngineVectorTests.load("s2"))
        for (i, expected) in vectors.cases.enumerated() {
            let state = try Facelets.state(from: expected.facelets)
            let plan = Planner.planColour(state, expected.face, lookahead: true)
            let context = "s2 case \(i), face \(expected.face)"
            XCTAssertEqual(plan.crossLength, expected.crossLength, context)
            XCTAssertEqual(plan.xcrossLength, expected.xcrossLength, context)
            compare(plan.cross, expected.cross, "\(context) cross")
            compare(plan.xcross, expected.keptXcross, "\(context) xcross")
            compare(plan.crossPlusOne ?? [], expected.crossPlusOne, "\(context) cross+1")
            compare(plan.crossPlusTwo ?? [], expected.crossPlusTwo, "\(context) cross+2")

            let slots = geometry[expected.face].slots
            let xcross = enumerateAllXcrosses(state, expected.face)
            let candidates = zip(slots, xcross).filter { $0.1.optimal >= 0 }
            let best = candidates.map { $0.1.optimal }.min()!
            XCTAssertEqual(candidates.count, expected.pairRanking.count, context)
            for ((slot, result), want) in zip(candidates, expected.pairRanking) {
                XCTAssertEqual(slot.name, want.slot, context)
                let row = Ranker.pairFeatures(
                    state.normalized, geometry[expected.face],
                    Ranker.PairCandidate(slot: slot, optimal: result.optimal,
                                         ways: result.candidates.count,
                                         bestMoves: result.candidates.first?.moves ?? []),
                    bestLength: best, previous: nil, step: 0, openCount: candidates.count)
                XCTAssertEqual(row.count, want.features.count, context)
                for (actual, expected) in zip(row, want.features) {
                    XCTAssertEqual(actual, expected, accuracy: 1e-6, context)
                }
                if let score = want.modelScore, let weights = Ranker.scorerFor(.pair) {
                    XCTAssertEqual(weights.score(row), score, accuracy: 1e-6, context)
                }
            }
        }
    }

    private func compare(_ actual: [PlannedSolution], _ expected: [Vectors.Plan], _ context: String) {
        XCTAssertEqual(actual.count, expected.count, context)
        for (i, pair) in zip(actual, expected).enumerated() {
            let (got, want) = pair
            let label = "\(context) #\(i)"
            XCTAssertEqual(got.kind.rawValue, want.kind, label)
            XCTAssertEqual(got.slot, want.slot, label)
            XCTAssertEqual(got.searchSlot, want.searchSlot, label)
            XCTAssertEqual(got.slotLabel, want.slotLabel, label)
            XCTAssertEqual(got.text, want.text, label)
            XCTAssertEqual(Notation.write(got.searchMoves), want.searchText, label)
            XCTAssertEqual(Notation.write(got.setup), want.setup, label)
            XCTAssertEqual(got.hold.down, want.down, label)
            XCTAssertEqual(got.hold.front, want.front, label)
            XCTAssertEqual(got.hold.rotation, want.rotation, label)
            XCTAssertEqual(got.comfort, want.comfort, accuracy: 1e-6, label)
            XCTAssertEqual(got.steps?.map(\.label), want.steps?.map(\.label), label)
            XCTAssertEqual(got.steps?.map(\.text), want.steps?.map(\.text), label)
            XCTAssertEqual(got.solvedPairLabels, want.solvedPairLabels, label)
        }
    }
}
