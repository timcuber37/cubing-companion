/// Exact lower bounds for one corner and edge pair, independent of the rest of the cube.
public enum PairTables {
    public static let indexSpace = 8 * 3 * 12 * 2
    public static let maxDistance = 6
    public static let unreachable: UInt8 = 255

    private static let cornerTo: [Int] = SearchMoves.all.flatMap { move in
        let after = CubeState.after([move])
        var to = [Int](repeating: 0, count: 8)
        for i in 0..<8 { to[Int(after.cp[i])] = i }
        return to
    }
    private static let cornerTwist: [Int] = SearchMoves.all.flatMap { move in
        let after = CubeState.after([move])
        var twist = [Int](repeating: 0, count: 8)
        for i in 0..<8 { twist[Int(after.cp[i])] = Int(after.co[i]) }
        return twist
    }

    public static func pack(_ corner: Int, _ twist: Int, _ edge: Int, _ flip: Int) -> Int {
        ((corner * 3 + twist) * 12 + edge) * 2 + flip
    }

    @inline(__always)
    static func step(_ index: Int, _ move: Int) -> Int {
        let flip = index & 1
        let edge = (index >> 1) % 12
        let twist = (index / 24) % 3
        let corner = index / 72
        let ci = move * 8 + corner
        let ei = move * 12 + edge
        return pack(
            cornerTo[ci], (twist + cornerTwist[ci]) % 3,
            CrossTables.edgeTo[ei], flip ^ CrossTables.edgeFlip[ei])
    }

    static func index(_ state: CubeState, _ slot: Slot) -> Int {
        let corner = (0..<8).first { Int(state.cp[$0]) == slot.corner }!
        let edge = (0..<12).first { Int(state.ep[$0]) == slot.edge }!
        return pack(corner, Int(state.co[corner]), edge, Int(state.eo[edge]))
    }

    static func index(_ state: CubeState, _ slot: Slot, _ inverseCp: [Int], _ inverseEp: [Int]) -> Int {
        let corner = inverseCp[slot.corner], edge = inverseEp[slot.edge]
        return pack(corner, Int(state.co[corner]), edge, Int(state.eo[edge]))
    }

    private static func build(_ slot: Slot) -> [UInt8] {
        var distance = [UInt8](repeating: unreachable, count: indexSpace)
        let solved = pack(slot.corner, 0, slot.edge, 0)
        distance[solved] = 0
        var frontier = [solved]
        var depth: UInt8 = 0
        while !frontier.isEmpty {
            var next: [Int] = []
            for index in frontier {
                for move in 0..<18 {
                    let child = step(index, move)
                    if distance[child] != unreachable { continue }
                    distance[child] = depth + 1
                    next.append(child)
                }
            }
            frontier = next
            depth += 1
        }
        return distance
    }

    // Twenty-four small tables, built once. Immutable after initialization, so readers need no lock.
    private static let tables: [Int: [UInt8]] = {
        var result: [Int: [UInt8]] = [:]
        for slot in geometry.flatMap(\.slots) { result[slot.corner * 12 + slot.edge] = build(slot) }
        return result
    }()

    public static func table(_ slot: Slot) -> [UInt8] { tables[slot.corner * 12 + slot.edge]! }

    /// The state may be held in any orientation.
    public static func distance(_ state: CubeState, _ slot: Slot) -> Int {
        let normalised = state.normalized
        return Int(table(slot)[index(normalised, slot)])
    }
}

public func pairDistance(_ state: CubeState, _ slot: Slot) -> Int {
    PairTables.distance(state, slot)
}
