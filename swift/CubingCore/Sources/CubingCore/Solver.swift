/// Exact cross distances and cross enumeration — the Swift counterpart of `crossTable.ts`,
/// `cross.ts`, `moves.ts` and `budget.ts` in `packages/solver`.
///
/// The cross has 12P4 × 2⁴ = 190,080 reachable positions, so a breadth-first sweep from solved
/// gives the exact optimal distance for every one; solutions come from walking down the table.
/// See `crossTable.ts` for the full reasoning. The move order, the pruning rule and the order of
/// the budget checks are all carried over exactly, because they decide *which* solutions come out
/// first and whether a capped enumeration reports itself truncated — both recorded in the vectors.

import Dispatch

// MARK: - Moves

public enum SearchMoves {
    public static let faceFamilies = ["U", "D", "L", "R", "F", "B"]
    public static let amounts = [1, 2, -1]

    /// The 18 HTM moves, in a fixed order so enumeration is deterministic.
    public static let all: [Move] = faceFamilies.flatMap { family in
        amounts.map { Move(family: family, amount: $0) }
    }
    static let transforms: [Transformation] = all.map { MoveTables.transformation(for: $0)! }

    /// Family index of each search move: pairs are (U,D), (L,R), (F,B).
    static let family: [Int] = all.indices.map { $0 / 3 }

    /// Whether move `next` may follow move `previous` (indices into `all`, -1 for none).
    ///
    /// Same face twice is redundant, and of a commuting opposite pair only the canonical order is
    /// searched. Both prunings are exact.
    @inline(__always)
    static func allowed(_ next: Int, after previous: Int) -> Bool {
        guard previous >= 0 else { return true }
        let a = family[next], b = family[previous]
        if a == b { return false }
        // Opposite faces are adjacent family indices 2k and 2k+1.
        if a / 2 != b / 2 { return true }
        return a > b
    }
}

// MARK: - Cross table

public enum CrossTables {
    public static let indexSpace = 12 * 12 * 12 * 12 * 16
    public static let reachablePositions = 190_080
    public static let maxDistance = 8
    public static let unreachable: UInt8 = 255

    /// `edgeTo[m * 12 + from]`: the slot an edge at `from` lands in under move `m`.
    static let edgeTo: [Int] = SearchMoves.all.flatMap { move -> [Int] in
        let after = CubeState.after([move])
        var to = [Int](repeating: 0, count: 12)
        for i in 0..<12 { to[Int(after.ep[i])] = i }
        return to
    }

    /// `edgeFlip[m * 12 + from]`: whether that edge flips on the way.
    static let edgeFlip: [Int] = SearchMoves.all.flatMap { move -> [Int] in
        let after = CubeState.after([move])
        var flip = [Int](repeating: 0, count: 12)
        for i in 0..<12 { flip[Int(after.ep[i])] = Int(after.eo[i]) }
        return flip
    }

    static func pack(slots: [Int], orientations: [Int]) -> Int {
        var position = 0, orientation = 0
        for i in 0..<4 {
            position = position * 12 + slots[i]
            orientation = orientation * 2 + orientations[i]
        }
        return position * 16 + orientation
    }

    /// Apply search move `m` to a packed cross position.
    @inline(__always)
    static func step(_ index: Int, _ m: Int) -> Int {
        var orientation = index & 15
        var position = index >> 4
        var slots = (0, 0, 0, 0), flips = (0, 0, 0, 0)
        slots.3 = position % 12; position /= 12; flips.3 = orientation & 1; orientation >>= 1
        slots.2 = position % 12; position /= 12; flips.2 = orientation & 1; orientation >>= 1
        slots.1 = position % 12; position /= 12; flips.1 = orientation & 1; orientation >>= 1
        slots.0 = position; flips.0 = orientation
        let base = m * 12
        return edgeTo.withUnsafeBufferPointer { to in
            edgeFlip.withUnsafeBufferPointer { flip in
                let p = ((to[base + slots.0] * 12 + to[base + slots.1]) * 12
                    + to[base + slots.2]) * 12 + to[base + slots.3]
                let o = (flips.0 ^ flip[base + slots.0]) << 3 | (flips.1 ^ flip[base + slots.1]) << 2
                    | (flips.2 ^ flip[base + slots.2]) << 1 | (flips.3 ^ flip[base + slots.3])
                return p * 16 + o
            }
        }
    }

    /// Index the cross position of an already-normalised state.
    static func index(normalised state: CubeState, edges: [Int]) -> Int {
        var slots = [0, 0, 0, 0], orientations = [0, 0, 0, 0]
        for i in 0..<4 {
            for s in 0..<12 where Int(state.ep[s]) == edges[i] {
                slots[i] = s
                orientations[i] = Int(state.eo[s])
                break
            }
        }
        return pack(slots: slots, orientations: orientations)
    }

    /// Search nodes already invert the edge permutation for pair bounds; reuse it for the cross.
    @inline(__always)
    static func index(normalised state: CubeState, edges: [Int], inverseEp: [Int]) -> Int {
        let a = inverseEp[edges[0]], b = inverseEp[edges[1]]
        let c = inverseEp[edges[2]], d = inverseEp[edges[3]]
        let positions = ((a * 12 + b) * 12 + c) * 12 + d
        let flips = (Int(state.eo[a]) << 3) | (Int(state.eo[b]) << 2)
            | (Int(state.eo[c]) << 1) | Int(state.eo[d])
        return positions * 16 + flips
    }

    public final class Table: Sendable {
        public let crossFace: Int
        public let edges: [Int]
        public let distance: [UInt8]
        public let solvedIndex: Int

        init(crossFace: Int) {
            self.crossFace = crossFace
            edges = geometry[crossFace].crossEdges
            solvedIndex = CrossTables.index(normalised: .solved, edges: edges)

            var distance = [UInt8](repeating: CrossTables.unreachable, count: CrossTables.indexSpace)
            distance[solvedIndex] = 0
            var frontier = [solvedIndex]
            var depth: UInt8 = 0
            while !frontier.isEmpty {
                var next: [Int] = []
                for index in frontier {
                    for m in 0..<18 {
                        let child = CrossTables.step(index, m)
                        if distance[child] != CrossTables.unreachable { continue }
                        distance[child] = depth + 1
                        next.append(child)
                    }
                }
                frontier = next
                depth += 1
            }
            self.distance = distance
        }

        public func distance(of state: CubeState) -> Int {
            Int(distance[CrossTables.index(normalised: state.normalized, edges: edges)])
        }
    }

    /// Built on first use and kept, one per cross colour — per colour rather than all six up
    /// front, because most solvers use one. Each builds under its own lock, so two colours can
    /// build concurrently but one colour never builds twice.
    private static let lazyTables: [LazyTable] = (0..<numCenters).map(LazyTable.init)

    /// One table, without paying for the other five.
    public static func table(_ face: Int) -> Table { lazyTables[face].value }

    /// Building all six at once — what a colour-neutral sweep needs, and what the benchmark times.
    public static func all() -> [Table] { (0..<numCenters).map(table) }

    final class LazyTable: @unchecked Sendable {
        let face: Int
        private var built: Table?
        private let lock = DispatchQueue(label: "cross-table")
        init(_ face: Int) { self.face = face }
        var value: Table {
            lock.sync {
                if let built { return built }
                let table = Table(crossFace: face)
                built = table
                return table
            }
        }
    }
}

/// Optimal number of moves to finish this cross, from a state in any orientation.
public func crossDistance(_ state: CubeState, _ crossFace: Int) -> Int {
    CrossTables.table(crossFace).distance(of: state)
}

// MARK: - Budget

/// A wall-clock deadline sampled every 4,096 nodes rather than read per node. See `budget.ts`.
struct Budget {
    static let sampleEvery = 4096
    private let deadline: DispatchTime?
    private var nextCheck = 0
    private var done = false

    init(deadlineMs: Double?) {
        guard let ms = deadlineMs, ms.isFinite else {
            deadline = nil
            return
        }
        deadline = .now() + .nanoseconds(Int(max(0, ms) * 1_000_000))
    }

    mutating func expired(_ nodes: Int) -> Bool {
        guard let deadline else { return false }
        if done { return true }
        if nodes < nextCheck { return false }
        nextCheck = nodes + Self.sampleEvery
        done = DispatchTime.now() >= deadline
        return done
    }
}

// MARK: - Enumeration

public struct SearchOptions: Sendable {
    public var maxExtra = 0
    public var maxSolutions = 200
    public var maxSolutionsPerDepth = Int.max
    public var maxNodes = Int.max
    public var deadlineMs: Double?
    public var maxDepth = Int.max
    public init() {}
}

public struct Candidate: Sendable {
    public let moves: [Move]
    public var length: Int { moves.count }
    public let overOptimal: Int
    public let slot: String?

    public init(moves: [Move], overOptimal: Int, slot: String? = nil) {
        self.moves = moves; self.overOptimal = overOptimal; self.slot = slot
    }
}

public struct SearchResult: Sendable {
    public let candidates: [Candidate]
    /// -1 when the position is outside the reachable set.
    public let optimal: Int
    public let nodes: Int
    public let truncated: Bool
}

/// Every way to finish the cross, shortest first.
public func enumerateCross(
    _ state: CubeState, _ crossFace: Int, _ options: SearchOptions = SearchOptions()
) -> SearchResult {
    let table = CrossTables.table(crossFace)
    let startIndex = CrossTables.index(normalised: state.normalized, edges: table.edges)
    let optimalByte = table.distance[startIndex]
    guard optimalByte != CrossTables.unreachable else {
        return SearchResult(candidates: [], optimal: -1, nodes: 0, truncated: false)
    }
    let optimal = Int(optimalByte)

    let (limit, overflow) = optimal.addingReportingOverflow(options.maxExtra)
    let depthLimit = min(overflow ? Int.max : limit, options.maxDepth)

    var candidates: [Candidate] = []
    var path: [Int] = []
    var nodes = 0
    var truncated = false
    var depthStart = 0
    var budget = Budget(deadlineMs: options.deadlineMs)

    // Order matters: `budget.expired` advances its sampling cursor, exactly as in the TypeScript.
    func limited() -> Bool {
        nodes >= options.maxNodes || budget.expired(nodes)
            || candidates.count >= options.maxSolutions
            || candidates.count - depthStart >= options.maxSolutionsPerDepth
    }

    table.distance.withUnsafeBufferPointer { distance in
        /// Depth-first for solutions of *exactly* `remaining` more moves.
        func search(_ index: Int, _ remaining: Int) {
            if limited() {
                truncated = true
                return
            }
            nodes += 1

            if index == table.solvedIndex {
                if remaining == 0 {
                    candidates.append(
                        Candidate(
                            moves: path.map { SearchMoves.all[$0] },
                            overOptimal: path.count - optimal))
                }
                return
            }
            if remaining == 0 { return }
            if Int(distance[index]) > remaining { return }

            let previous = path.last ?? -1
            for m in 0..<18 {
                if !SearchMoves.allowed(m, after: previous) { continue }
                path.append(m)
                search(CrossTables.step(index, m), remaining - 1)
                path.removeLast()
                if limited() {
                    truncated = true
                    return
                }
            }
        }

        var depth = optimal
        while depth <= depthLimit {
            depthStart = candidates.count
            search(startIndex, depth)
            if nodes >= options.maxNodes || budget.expired(nodes) {
                truncated = true
                break
            }
            if candidates.count >= options.maxSolutions { break }
            depth += 1
        }
    }
    // `maxDepth` cut the search short of what `maxExtra` asked for.
    if depthLimit < (overflow ? Int.max : limit) { truncated = true }

    return SearchResult(candidates: candidates, optimal: optimal, nodes: nodes, truncated: truncated)
}

/// One optimal solution, or nil if the cross is already finished.
public func solveCross(_ state: CubeState, _ crossFace: Int) -> [Move]? {
    var options = SearchOptions()
    options.maxSolutions = 1
    guard let first = enumerateCross(state, crossFace, options).candidates.first,
        !first.moves.isEmpty
    else { return nil }
    return first.moves
}
