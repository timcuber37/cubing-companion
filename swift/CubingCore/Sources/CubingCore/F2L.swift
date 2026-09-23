/// Search for a target pair while keeping the cross and any required pairs intact at the end.
public enum F2L {
    public static let maxInsertionDepth = 12
    public static let maxXcrossDepth = 11

    public static func insertion(
        _ state: CubeState, _ crossFace: Int, _ target: Slot,
        options: SearchOptions = insertionDefaults(), preserve: [Slot]? = nil
    ) -> SearchResult {
        let crossTable = CrossTables.table(crossFace)
        let slots = geometry[crossFace].slots
        var working = state.normalized
        let preserved = preserve ?? slots.filter { $0 != target && isSlotSolved(working, $0) }
        let required = [target] + preserved
        let distances = required.map(PairTables.table)
        let ceiling = min(options.maxDepth, maxInsertionDepth)
        var candidates: [Candidate] = []
        var path: [Int] = []
        var inverseCp = [Int](repeating: 0, count: 8)
        var inverseEp = [Int](repeating: 0, count: 12)
        var nodes = 0, depthStart = 0, optimal = -1
        var truncated = false
        var budget = Budget(deadlineMs: options.deadlineMs)

        func limited() -> Bool {
            nodes >= options.maxNodes || budget.expired(nodes)
                || candidates.count >= options.maxSolutions
                || candidates.count - depthStart >= options.maxSolutionsPerDepth
        }

        func search(_ remaining: Int) {
            if limited() { truncated = true; return }
            nodes += 1
            for i in 0..<8 { inverseCp[Int(working.cp[i])] = i }
            for i in 0..<12 { inverseEp[Int(working.ep[i])] = i }
            let crossLeft = Int(crossTable.distance[
                CrossTables.index(normalised: working, edges: crossTable.edges, inverseEp: inverseEp)])
            var bound = crossLeft
            var allHome = crossLeft == 0
            for (i, slot) in required.enumerated() {
                let left = Int(distances[i][PairTables.index(working, slot, inverseCp, inverseEp)])
                bound = max(bound, left)
                if left != 0 { allHome = false }
            }
            if allHome {
                if remaining == 0 {
                    candidates.append(Candidate(
                        moves: path.map { SearchMoves.all[$0] },
                        overOptimal: optimal < 0 ? 0 : path.count - optimal,
                        slot: target.name))
                }
                return
            }
            if remaining == 0 || bound > remaining { return }

            for move in 0..<18 {
                if !SearchMoves.allowed(move, after: path.last ?? -1) { continue }
                let before = working
                working = working.applying(SearchMoves.transforms[move])
                path.append(move)
                search(remaining - 1)
                path.removeLast()
                working = before
                if limited() { truncated = true; return }
            }
        }

        if ceiling >= 0 {
            for depth in 0...ceiling {
                depthStart = candidates.count
                search(depth)
                if !candidates.isEmpty {
                    if optimal == -1 { optimal = candidates[0].length }
                    if depth >= optimal + options.maxExtra { break }
                }
                if nodes >= options.maxNodes || budget.expired(nodes) {
                    truncated = true
                    break
                }
                if candidates.count >= options.maxSolutions { break }
            }
        }
        if optimal < 0 || ceiling < optimal + options.maxExtra { truncated = true }
        return SearchResult(candidates: candidates, optimal: optimal, nodes: nodes, truncated: truncated)
    }

    public static func xcross(
        _ state: CubeState, _ crossFace: Int, _ slot: Slot,
        options: SearchOptions = insertionDefaults()
    ) -> SearchResult {
        var limited = options
        limited.maxDepth = min(limited.maxDepth, maxXcrossDepth)
        return insertion(state, crossFace, slot, options: limited, preserve: [])
    }

    public static func allXcrosses(
        _ state: CubeState, _ crossFace: Int, options: SearchOptions = insertionDefaults()
    ) -> [SearchResult] {
        geometry[crossFace].slots.map { xcross(state, crossFace, $0, options: options) }
    }

    public struct NextPairOption: Sendable {
        public let slot: Slot
        public let result: SearchResult
    }

    public static func nextPair(
        _ state: CubeState, _ crossFace: Int,
        options: SearchOptions = insertionDefaults(), preserve: [Slot]? = nil
    ) -> [NextPairOption] {
        let normalised = state.normalized
        return geometry[crossFace].slots.enumerated()
            .filter { !isSlotSolved(normalised, $0.element) }
            .map { index, slot in
                (index, NextPairOption(
                    slot: slot,
                    result: insertion(state, crossFace, slot, options: options, preserve: preserve)))
            }.sorted { a, b in
                let left = a.1.result.optimal < 0 ? Int.max : a.1.result.optimal
                let right = b.1.result.optimal < 0 ? Int.max : b.1.result.optimal
                return left == right ? a.0 < b.0 : left < right
            }.map(\.1)
    }
}

public func insertionDefaults() -> SearchOptions {
    var options = SearchOptions()
    options.maxSolutions = 50
    return options
}

public func enumerateF2LInsertion(
    _ state: CubeState, _ crossFace: Int, _ target: Slot,
    options: SearchOptions = insertionDefaults(), preserve: [Slot]? = nil
) -> SearchResult {
    F2L.insertion(state, crossFace, target, options: options, preserve: preserve)
}

public func enumerateAllXcrosses(
    _ state: CubeState, _ crossFace: Int, options: SearchOptions = insertionDefaults()
) -> [SearchResult] {
    F2L.allXcrosses(state, crossFace, options: options)
}
