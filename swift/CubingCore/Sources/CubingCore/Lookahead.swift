/// Bounded beam search through preserving F2L insertions.
public enum Lookahead {
    public struct Options: Sendable {
        public var depth = 2
        public var beamWidth = 4
        public var maxExtra = 1
        public var maxNodes = 400_000
        public var maxNodesPerSearch = 50_000
        public var firstSlot: Slot?
        public init() {}
    }

    public struct PairStep: Sendable {
        public let slot: String
        public let moves: [Move]
        public let solvedSlots: [String]
    }

    public struct Continuation: Sendable {
        public let moves: [Move]
        public let steps: [PairStep]
        public let solvedSlots: [String]
    }

    public struct Result: Sendable {
        public let candidates: [Continuation]
        public let prefixes: [Continuation]
        public let nodes: Int
        public let truncated: Bool
    }

    public struct PairOption: Sendable {
        public let slot: Slot
        public let plan: Continuation?
    }

    public struct PairResult: Sendable {
        public let options: [PairOption]
        public let depth: Int
        public let nodes: Int
        public let truncated: Bool
    }

    private struct Path {
        let state: CubeState
        let moves: [Move]
        let steps: [PairStep]
        let solvedSlots: [String]
        var continuation: Continuation {
            Continuation(moves: moves, steps: steps, solvedSlots: solvedSlots)
        }
    }

    private struct CacheKey: Hashable {
        let state: CubeState
        let slot: String
    }

    public static func continueF2L(
        _ raw: CubeState, _ crossFace: Int, targetPairs: Int, options: Options = Options()
    ) -> Result {
        precondition((0...4).contains(targetPairs))
        precondition(options.beamWidth >= 1 && (0...3).contains(options.maxExtra))
        let state = raw.normalized
        precondition(crossDistance(state, crossFace) == 0, "F2L lookahead requires a solved cross")
        let slots = geometry[crossFace].slots
        if let first = options.firstSlot { precondition(slots.contains(first)) }

        func solved(_ state: CubeState) -> [Slot] { slots.filter { isSlotSolved(state, $0) } }
        func names(_ state: CubeState) -> [String] { solved(state).map(\.name) }
        func lowerBound(_ path: Path) -> Int {
            let needed = targetPairs - path.solvedSlots.count
            if needed <= 0 { return 0 }
            let distances = slots.filter { !isSlotSolved(path.state, $0) }
                .map { pairDistance(path.state, $0) }.sorted()
            return distances[needed - 1]
        }
        func accessible(_ path: Path) -> Int {
            slots.reduce(0) { count, slot in
                if isSlotSolved(path.state, slot) { return count }
                let corner = (0..<8).first { Int(path.state.cp[$0]) == slot.corner }!
                let edge = (0..<12).first { Int(path.state.ep[$0]) == slot.edge }!
                return count + (geometry[crossFace].llCorners.contains(corner) ? 1 : 0)
                    + (geometry[crossFace].llEdges.contains(edge) ? 1 : 0)
            }
        }
        func compare(_ a: Path, _ b: Path) -> Int {
            let score = a.moves.count + lowerBound(a) - b.moves.count - lowerBound(b)
            if score != 0 { return score }
            let solved = b.solvedSlots.count - a.solvedSlots.count
            if solved != 0 { return solved }
            return accessible(b) - accessible(a)
        }
        func stableSort(_ paths: [Path]) -> [Path] {
            paths.enumerated().sorted { a, b in
                let order = compare(a.element, b.element)
                return order == 0 ? a.offset < b.offset : order < 0
            }.map(\.element)
        }

        var nodes = 0, truncated = false
        var cache: [CacheKey: SearchResult] = [:]
        var beam = [Path(state: state, moves: [], steps: [], solvedSlots: names(state))]
        var completed: [Path] = []
        var prefixes: [CubeState: Path] = [:]
        var prefixOrder: [CubeState] = []

        for level in 0...4 {
            var next: [CubeState: Path] = [:]
            var nextOrder: [CubeState] = []
            for path in beam {
                if path.solvedSlots.count >= targetPairs {
                    completed.append(path)
                    continue
                }
                let open = slots.filter {
                    !isSlotSolved(path.state, $0)
                        && (level != 0 || options.firstSlot == nil || $0 == options.firstSlot!)
                }
                for slot in open {
                    let key = CacheKey(state: path.state, slot: slot.name)
                    var result = cache[key]
                    if result == nil {
                        if nodes >= options.maxNodes { truncated = true; continue }
                        var search = insertionDefaults()
                        search.maxExtra = options.maxExtra
                        search.maxSolutions = options.beamWidth * (options.maxExtra + 1)
                        search.maxSolutionsPerDepth = options.beamWidth
                        search.maxNodes = min(options.maxNodesPerSearch, options.maxNodes - nodes)
                        result = enumerateF2LInsertion(path.state, crossFace, slot, options: search)
                        nodes += result!.nodes
                        truncated = truncated || result!.truncated
                        cache[key] = result
                    }
                    for candidate in result!.candidates {
                        let after = path.state.applying(candidate.moves)
                        let solvedSlots = names(after)
                        let child = Path(
                            state: after, moves: path.moves + candidate.moves,
                            steps: path.steps + [PairStep(
                                slot: slot.name, moves: candidate.moves, solvedSlots: solvedSlots)],
                            solvedSlots: solvedSlots)
                        if let previous = next[after] {
                            if compare(child, previous) < 0 { next[after] = child }
                        } else {
                            next[after] = child
                            nextOrder.append(after)
                        }
                        if solvedSlots.count < targetPairs {
                            if let previous = prefixes[after] {
                                if child.moves.count < previous.moves.count { prefixes[after] = child }
                            } else {
                                prefixes[after] = child
                                prefixOrder.append(after)
                            }
                        }
                    }
                }
            }
            var pending: [Path] = []
            for key in nextOrder {
                let path = next[key]!
                if path.solvedSlots.count >= targetPairs { completed.append(path) }
                else { pending.append(path) }
            }
            pending = stableSort(pending)
            if pending.count > options.beamWidth { truncated = true }
            beam = Array(pending.prefix(options.beamWidth))
            if beam.isEmpty { break }
        }
        var unique: [CubeState: Path] = [:]
        var uniqueOrder: [CubeState] = []
        for path in stableSort(completed) where unique[path.state] == nil {
            unique[path.state] = path
            uniqueOrder.append(path.state)
        }
        return Result(
            candidates: uniqueOrder.prefix(options.beamWidth).map { unique[$0]!.continuation },
            prefixes: prefixOrder.map { prefixes[$0]!.continuation },
            nodes: nodes, truncated: truncated || uniqueOrder.count > options.beamWidth)
    }

    /// `lookaheadPairs` in `lookahead.ts`: the whole budget across every open slot.
    ///
    /// `totalNodes` is that budget, split evenly between the slots, and it is separate from
    /// `options.maxNodes` because the TypeScript's defaults differ: 1,600,000 here, 400,000 for a
    /// single `continueF2L`. This once divided `options.maxNodes` — so each slot searched a quarter
    /// of what the TypeScript searches, found different plans wherever the search is budget-bound,
    /// and made the S2 benchmark compare a quarter of the work against the whole of it. The review
    /// oracle (`vectors/review.json`), which records these plans, is what caught it.
    public static let defaultTotalNodes = 1_600_000

    public static func pairs(
        _ raw: CubeState, _ crossFace: Int, options: Options = Options(),
        totalNodes: Int = defaultTotalNodes
    ) -> PairResult {
        let state = raw.normalized
        precondition(crossDistance(state, crossFace) == 0)
        let open = geometry[crossFace].slots.filter { !isSlotSolved(state, $0) }
        let depth = min(options.depth, open.count)
        var nodes = 0, truncated = false
        let ranked = open.enumerated().map { index, slot -> (Int, PairOption) in
            var slotOptions = options
            slotOptions.firstSlot = slot
            slotOptions.maxNodes = totalNodes / open.count
            let result = continueF2L(
                state, crossFace, targetPairs: 4 - open.count + depth, options: slotOptions)
            nodes += result.nodes
            truncated = truncated || result.truncated
            return (index, PairOption(slot: slot, plan: result.candidates.first))
        }.sorted { a, b in
            let left = a.1.plan?.moves.count ?? Int.max
            let right = b.1.plan?.moves.count ?? Int.max
            return left == right ? a.0 < b.0 : left < right
        }
        return PairResult(options: ranked.map(\.1), depth: depth, nodes: nodes, truncated: truncated)
    }
}
