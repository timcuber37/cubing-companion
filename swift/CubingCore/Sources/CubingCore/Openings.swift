/// Cross-first and joint cross/pair routes to one or two solved pairs.
public enum Openings {
    public struct Step: Sendable {
        public let label: String
        public let moves: [Move]
    }
    public struct Opening: Sendable {
        public let moves: [Move]
        public let steps: [Step]
        public let solvedSlots: [String]
    }
    public struct Result: Sendable {
        public let crossPlusOne: [Opening]
        public let crossPlusTwo: [Opening]
    }
    private struct Seed {
        let state: CubeState
        let moves: [Move]
        let steps: [Step]
    }

    private static func combineTurns(_ moves: [Move]) -> [Move] {
        var combined: [Move] = []
        for move in moves {
            guard let previous = combined.last, previous.familyIndex == move.familyIndex else {
                combined.append(move)
                continue
            }
            combined.removeLast()
            let amount = MoveTables.normalizeAmount(previous.amount + move.amount)
            if amount != 0 { combined.append(Move(familyIndex: move.familyIndex, amount: amount)) }
        }
        return combined
    }

    public static func search(
        _ raw: CubeState, _ crossFace: Int, xcrosses: [[Move]]
    ) -> Result {
        let state = raw.normalized
        let slots = geometry[crossFace].slots
        func solved(_ state: CubeState) -> [Slot] { slots.filter { isSlotSolved(state, $0) } }
        var plusOne: [Opening] = []
        var plusTwo: [Opening] = []

        func collect(_ moves: [Move], _ steps: [Step], _ after: CubeState) {
            let built = solved(after)
            let solvedSlots = built.map(\.name)
            let combined = combineTurns(moves)
            let opening: Opening
            if combined.count < moves.count {
                opening = Opening(
                    moves: combined,
                    steps: [Step(label: "cross + \(built.map(Colours.slot).joined(separator: " + "))",
                                 moves: combined)],
                    solvedSlots: solvedSlots)
            } else {
                opening = Opening(moves: moves, steps: steps, solvedSlots: solvedSlots)
            }
            if solvedSlots.count >= 1 { plusOne.append(opening) }
            if solvedSlots.count >= 2 { plusTwo.append(opening) }
        }

        var crossOptions = SearchOptions()
        crossOptions.maxExtra = 1
        crossOptions.maxSolutions = 24
        crossOptions.maxSolutionsPerDepth = 12
        crossOptions.maxNodes = 100_000
        let cross = enumerateCross(state, crossFace, crossOptions)
        var seeds: [CubeState: Seed] = [:]
        var seedOrder: [CubeState] = []
        for moves in cross.candidates.map(\.moves) + xcrosses {
            let after = state.applying(moves)
            let built = solved(after)
            let label = built.isEmpty ? "cross" : "cross + \(built.map(Colours.slot).joined(separator: " + "))"
            let steps = [Step(label: label, moves: moves)]
            if let previous = seeds[after] {
                if previous.moves.count > moves.count {
                    seeds[after] = Seed(state: after, moves: moves, steps: steps)
                }
            } else {
                seeds[after] = Seed(state: after, moves: moves, steps: steps)
                seedOrder.append(after)
            }
            collect(moves, steps, after)
        }
        func estimate(_ seed: Seed) -> Int {
            let needed = max(0, 2 - solved(seed.state).count)
            let distances = slots.filter { !isSlotSolved(seed.state, $0) }
                .map { pairDistance(seed.state, $0) }.sorted()
            return seed.moves.count + (needed == 0 ? 0 : distances[needed - 1])
        }
        func sortSeeds(_ values: [Seed]) -> [Seed] {
            values.enumerated().sorted { a, b in
                let left = estimate(a.element), right = estimate(b.element)
                return left == right ? a.offset < b.offset : left < right
            }.map(\.element)
        }
        let ordered = sortSeeds(seedOrder.map { seeds[$0]! })
        var groups: [String: [Seed]] = [:]
        var groupOrder: [String] = []
        for seed in ordered {
            let key = "\(seed.moves.count):\(solved(seed.state).map(\.name).joined(separator: ","))"
            if groups[key] == nil { groups[key] = []; groupOrder.append(key) }
            groups[key]!.append(seed)
        }
        var selected = Array(groupOrder.prefix(8).map { groups[$0]!.removeFirst() })
        let leftovers = sortSeeds(groupOrder.flatMap { groups[$0]! })
        for seed in leftovers {
            if selected.count >= 8 { break }
            selected.append(seed)
        }

        for seed in selected {
            var options = Lookahead.Options()
            options.maxNodes = 300_000
            let result = Lookahead.continueF2L(seed.state, crossFace, targetPairs: 2, options: options)
            for continuation in result.prefixes + result.candidates {
                var after = seed.state
                var moves = seed.moves
                var steps = seed.steps
                for step in continuation.steps {
                    after = after.applying(step.moves)
                    moves += step.moves
                    let slot = slots.first { $0.name == step.slot }!
                    steps.append(Step(label: Colours.slot(slot), moves: step.moves))
                    collect(moves, steps, after)
                }
            }
        }
        for first in 0..<slots.count {
            for second in (first + 1)..<slots.count {
                let pair = [slots[first], slots[second]]
                var options = insertionDefaults()
                options.maxDepth = 11
                options.maxSolutions = 3
                options.maxNodes = 50_000
                let result = enumerateF2LInsertion(
                    state, crossFace, pair[0], options: options, preserve: [pair[1]])
                for candidate in result.candidates {
                    collect(candidate.moves,
                            [Step(label: "cross + \(pair.map(Colours.slot).joined(separator: " + "))",
                                  moves: candidate.moves)],
                            state.applying(candidate.moves))
                }
            }
        }
        func unique(_ openings: [Opening]) -> [Opening] {
            var keyed: [[Move]: Opening] = [:]
            var order: [[Move]] = []
            for opening in openings {
                if keyed[opening.moves] == nil { order.append(opening.moves) }
                keyed[opening.moves] = opening
            }
            return order.map { keyed[$0]! }
        }
        return Result(crossPlusOne: unique(plusOne), crossPlusTwo: unique(plusTwo))
    }
}
