/// The model's inference-side feature extraction and ranking.
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public enum Ranker {
    public enum Head: Sendable { case cross, pair }
    public static func scorerFor(_ head: Head) -> MlpWeights? {
        switch head {
        case .cross: Weights.cross
        case .pair: Weights.pair
        }
    }

    public struct PairCandidate: Sendable {
        public let slot: Slot
        public let optimal: Int
        public let ways: Int
        public let bestMoves: [Move]
        public init(slot: Slot, optimal: Int, ways: Int, bestMoves: [Move]) {
            self.slot = slot; self.optimal = optimal; self.ways = ways; self.bestMoves = bestMoves
        }
    }

    public struct PairContext: Sendable {
        public let previous: Slot?
        public let step: Int
        public init(previous: Slot?, step: Int) { self.previous = previous; self.step = step }
    }

    public struct RankedSlot: Sendable {
        public let slot: Slot
        public let optimal: Int
        public let score: Double
        public let confidence: Double
        public let features: [Double]
    }

    public static let pairFeatureNames = [
        "insertionLength", "excessOverBest", "pairDistance", "logWays",
        "cornerOnTop", "cornerInOwnSlot", "edgeOnTop", "edgeInOwnSlot",
        "backTurns", "adjacentToPrevious", "stepIndex", "openCount",
    ]

    public static func pairFeatures(
        _ state: CubeState, _ geometry: CrossGeometry, _ candidate: PairCandidate,
        bestLength: Int, previous: Slot?, step: Int, openCount: Int
    ) -> [Double] {
        let corner = (0..<8).first { Int(state.cp[$0]) == candidate.slot.corner }!
        let edge = (0..<12).first { Int(state.ep[$0]) == candidate.slot.edge }!
        let adjacent = previous.map { other in
            candidate.slot.name.contains { other.name.contains($0) }
        } ?? false
        return [
            Double(candidate.optimal), Double(candidate.optimal - bestLength),
            Double(pairDistance(state, candidate.slot)), log1p(Double(candidate.ways)),
            geometry.llCorners.contains(corner) ? 1 : 0,
            corner == candidate.slot.corner ? 1 : 0,
            geometry.llEdges.contains(edge) ? 1 : 0,
            edge == candidate.slot.edge ? 1 : 0,
            Double(candidate.bestMoves.filter { $0.familyIndex == 5 }.count),
            adjacent ? 1 : 0, Double(step), Double(openCount),
        ]
    }

    public static func rankNextPair(
        _ state: CubeState, _ geometry: CrossGeometry, candidates: [PairCandidate],
        context: PairContext, score: ([Double]) -> Double
    ) -> [RankedSlot] {
        guard !candidates.isEmpty else { return [] }
        let best = candidates.map(\.optimal).min()!
        let rows = candidates.map {
            pairFeatures(state, geometry, $0, bestLength: best,
                         previous: context.previous, step: context.step, openCount: candidates.count)
        }
        let scores = rows.map(score)
        let peak = scores.max()!
        let exponentials = scores.map { exp($0 - peak) }
        let total = exponentials.reduce(0, +)
        return candidates.indices.map { i in
            RankedSlot(slot: candidates[i].slot, optimal: candidates[i].optimal,
                       score: scores[i], confidence: exponentials[i] / total, features: rows[i])
        }.enumerated().sorted { a, b in
            let left = a.element.score, right = b.element.score
            return left == right ? a.offset < b.offset : left > right
        }.map(\.element)
    }

    public static func rankByMoveCount(_ candidates: [PairCandidate]) -> [PairCandidate] {
        candidates.enumerated().sorted { a, b in
            let left = a.element.optimal, right = b.element.optimal
            return left == right ? a.offset < b.offset : left < right
        }.map(\.element)
    }

    /// Reconsider all four grips for each retained cross, then rank by length and model score.
    public static func rerankCross(
        _ solutions: [PlannedSolution], startCentres: FixedBytes,
        score: ([Double]) -> Double
    ) -> [PlannedSolution] {
        var ranked: [PlannedSolution] = []
        for solution in solutions {
            var winner: (frame: Orientation, moves: [Move], score: Double)?
            for frame in Orientation.withColourDown(solution.crossFace) {
                let moves = frame.rename(solution.searchMoves)
                let value = score(Features.cross(moves))
                if winner == nil || value > winner!.score {
                    winner = (frame, moves, value)
                }
            }
            let choice = winner!
            var updated = solution
            updated.moves = choice.moves
            updated.setup = Orientation.rotationBetween(startCentres.map(Int.init), choice.frame.colourAt)
            updated.hold = Hold(
                down: choice.frame.colourAt[Face.d.rawValue],
                front: choice.frame.colourAt[Face.f.rawValue], rotation: choice.frame.text)
            updated.comfort = Comfort.score(choice.moves)
            updated.awkward = Comfort.awkwardTurns(choice.moves)
            updated.modelScore = choice.score
            if let searchSlot = solution.searchSlot {
                updated.slot = choice.frame.renameSlot(searchSlot)
            }
            ranked.append(updated)
        }
        return ranked.enumerated().sorted { a, b in
            if a.element.length != b.element.length { return a.element.length < b.element.length }
            if a.element.modelScore != b.element.modelScore {
                return a.element.modelScore! > b.element.modelScore!
            }
            return a.offset < b.offset
        }.map(\.element)
    }
}
