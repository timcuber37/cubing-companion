/// Cube state, moves, and their composition — the Swift counterpart of `packages/engine`.
///
/// The data model is carried over deliberately unchanged: permutation and orientation arrays in
/// cubing.js's own piece indexing, so a state here and a state there mean the same thing and the
/// recorded vectors can compare them directly. Facelets are the interchange format, not the
/// representation; see `Facelets.swift`.
///
/// Every move family — face, wide, slice, rotation — resolves to a precomputed transformation and
/// composes. There is no special case for slices or rotations, which is what stops rotation
/// handling drifting out of step with face turns.

/// Centre slot indices — a fixed position in space, not a colour.
///
/// **U L F R B D**, matching `packages/engine/src/state.ts`, and *not* the U R F D L B order of a
/// facelet string. The first draft of this port had them the wrong way round and still passed all
/// 3,000 engine vectors, because none of those cases record a face index. Every corpus after the
/// engine's does, so the mistake would have surfaced as a mis-mapped cross colour everywhere at
/// once — `testFaceOrderMatchesTheTypeScript` now pins it on its own.
public enum Face: Int, Sendable, CaseIterable {
    case u = 0, l = 1, f = 2, r = 3, b = 4, d = 5
}

public let numCorners = 8
public let numEdges = 12
public let numCenters = 6

/// A single move. The family is an integer in the hot path; strings are for notation only.
public struct Move: Hashable, Sendable {
    public let familyIndex: UInt8
    public var family: String { families[Int(familyIndex)] }
    public let amount: Int

    public init(family: String, amount: Int) {
        guard let resolved = MoveTables.resolve(family) else {
            preconditionFailure("unrecognized move family: \(family)")
        }
        self.familyIndex = UInt8(resolved.index)
        self.amount = amount
    }

    init(familyIndex: UInt8, amount: Int) {
        self.familyIndex = familyIndex
        self.amount = amount
    }

    /// The move that undoes this one.
    public var inverted: Move {
        Move(familyIndex: familyIndex, amount: amount == 2 ? 2 : -amount)
    }

    /// `R`, `R2`, `R'`.
    public var notation: String {
        family + (amount == 2 ? "2" : amount == -1 ? "'" : "")
    }
}

/// Small fixed-size piece storage. Each field stays inside its cube value during search copies.
public struct FixedBytes: RandomAccessCollection, MutableCollection, Hashable, Sendable {
    public typealias Index = Int
    private var lanes: SIMD16<UInt8>
    public let count: Int
    public var startIndex: Int { 0 }
    public var endIndex: Int { count }

    public init(_ bytes: [UInt8]) {
        precondition(bytes.count <= 16)
        count = bytes.count
        lanes = SIMD16<UInt8>(repeating: 0)
        for i in bytes.indices { lanes[i] = bytes[i] }
    }

    public subscript(position: Int) -> UInt8 {
        get { precondition(position >= 0 && position < count); return lanes[position] }
        set { precondition(position >= 0 && position < count); lanes[position] = newValue }
    }
}

public struct CubeState: Equatable, Sendable {
    /// `cp[slot]` is the corner piece sitting in that slot.
    public var cp: FixedBytes
    /// Corner orientation, mod 3.
    public var co: FixedBytes
    public var ep: FixedBytes
    /// Edge orientation, mod 2.
    public var eo: FixedBytes
    /// `centers[slot]` is the centre piece in that slot — how a rotated cube is represented.
    public var centers: FixedBytes

    public static let solved = CubeState(
        cp: Array(0..<UInt8(8)), co: [UInt8](repeating: 0, count: 8),
        ep: Array(0..<UInt8(12)), eo: [UInt8](repeating: 0, count: 12),
        centers: Array(0..<UInt8(6))
    )

    public init(cp: [UInt8], co: [UInt8], ep: [UInt8], eo: [UInt8], centers: [UInt8]) {
        self.cp = FixedBytes(cp); self.co = FixedBytes(co)
        self.ep = FixedBytes(ep); self.eo = FixedBytes(eo); self.centers = FixedBytes(centers)
    }

    /// Compose with a transformation.
    ///
    /// KPuzzle semantics: the piece landing in slot `i` comes from slot `t.xp[i]` and carries its
    /// own orientation plus the transformation's delta.
    public func applying(_ t: Transformation) -> CubeState {
        var next = self
        for i in 0..<numCorners {
            let from = Int(t.cp[i])
            next.cp[i] = cp[from]
            next.co[i] = (co[from] + t.co[i]) % 3
        }
        for i in 0..<numEdges {
            let from = Int(t.ep[i])
            next.ep[i] = ep[from]
            next.eo[i] = (eo[from] + t.eo[i]) & 1
        }
        for i in 0..<numCenters {
            next.centers[i] = centers[Int(t.centers[i])]
        }
        return next
    }

    public func applying(_ moves: [Move]) -> CubeState {
        moves.reduce(self) { state, move in
            guard let t = MoveTables.transformation(for: move) else { return state }
            return state.applying(t)
        }
    }

    public static func after(_ moves: [Move]) -> CubeState {
        solved.applying(moves)
    }

    /// True when every centre is in its home slot — the cube has not been rotated.
    public var isStandardOrientation: Bool {
        centers.enumerated().allSatisfy { Int($0.element) == $0.offset }
    }

    /// Solved, in whichever of the 24 orientations the centres say it is held.
    public var isSolvedIgnoringOrientation: Bool {
        Orientations.reference[centers] == self
    }

    /// The same position rotated so the centres are home.
    ///
    /// The rotation is fully determined by the centres — there are 24 orientations and each has a
    /// distinct centre arrangement — so the result does not depend on *which* rotation sequence
    /// reaches it, only on getting the arrangement right.
    public var normalized: CubeState {
        guard let path = Orientations.path[centers] else { return self }
        return applying(path.reversed().map(\.inverted))
    }
}

/// The 24 whole-cube orientations, found breadth-first from x, y and z.
enum Orientations {
    static let rotations = [
        Move(family: "x", amount: 1), Move(family: "y", amount: 1), Move(family: "z", amount: 1),
    ]

    /// Centre arrangement to the shortest rotation that produces it from standard.
    static let path: [FixedBytes: [Move]] = {
        var result: [FixedBytes: [Move]] = [CubeState.solved.centers: []]
        var queue: [(CubeState, [Move])] = [(.solved, [])]
        var seen: Set<CubeState> = [.solved]
        var head = 0
        while head < queue.count {
            let (state, moves) = queue[head]
            head += 1
            for rotation in rotations {
                let next = state.applying([rotation])
                guard seen.insert(next).inserted else { continue }
                queue.append((next, moves + [rotation]))
                if result[next.centers] == nil { result[next.centers] = moves + [rotation] }
            }
        }
        return result
    }()

    /// Centre arrangement to the solved cube held that way.
    static let reference: [FixedBytes: CubeState] = {
        var result: [FixedBytes: CubeState] = [:]
        for (centers, moves) in path { result[centers] = CubeState.solved.applying(moves) }
        return result
    }()
}

extension CubeState: Hashable {}

public enum MoveTables {
    /// Aliases accepted on input, mapped to a canonical family and a direction.
    ///
    /// `sign == -1` means the alias turns the opposite way from the canonical family, so `Lv` —
    /// the rotation following L — is `x'`. Carried over from the TypeScript verbatim, including
    /// the deliberate absence of `2U`-style single-inner-layer moves, which are not `u` and do not
    /// occur in CFOP reconstructions.
    static let aliases: [String: (family: String, sign: Int)] = [
        "u": ("Uw", 1), "d": ("Dw", 1), "l": ("Lw", 1),
        "r": ("Rw", 1), "f": ("Fw", 1), "b": ("Bw", 1),
        "Uv": ("y", 1), "Dv": ("y", -1),
        "Rv": ("x", 1), "Lv": ("x", -1),
        "Fv": ("z", 1), "Bv": ("z", -1),
    ]

    private static let familyIndex: [String: Int] = {
        var index: [String: Int] = [:]
        for (i, family) in families.enumerated() { index[family] = i }
        return index
    }()

    public struct ResolvedFamily {
        public let index: Int
        public let family: String
        public let sign: Int
    }

    /// Resolve a written family name, canonical or alias.
    public static func resolve(_ name: String) -> ResolvedFamily? {
        if let direct = familyIndex[name] {
            return ResolvedFamily(index: direct, family: families[direct], sign: 1)
        }
        guard let alias = aliases[name], let index = familyIndex[alias.family] else { return nil }
        return ResolvedFamily(index: index, family: alias.family, sign: alias.sign)
    }

    /// Reduce a raw quarter-turn count mod 4. Zero means a whole rotation, which callers drop.
    public static func normalizeAmount(_ raw: Int) -> Int {
        let n = ((raw % 4) + 4) % 4
        return n == 0 ? 0 : n == 1 ? 1 : n == 2 ? 2 : -1
    }

    /// Build a move from a written family and amount.
    ///
    /// Returns nil for an unknown family *and* for a well-formed no-op such as `R4`; the notation
    /// layer distinguishes them so it can reject a typo while silently dropping an identity move.
    public static func make(family: String, amount rawAmount: Int) -> Move? {
        guard let resolved = resolve(family) else { return nil }
        let amount = normalizeAmount(rawAmount * resolved.sign)
        guard amount != 0 else { return nil }
        return Move(family: resolved.family, amount: amount)
    }

    public static func transformation(for move: Move) -> Transformation? {
        let slot = move.amount == -1 ? 3 : move.amount
        return transformations[Int(move.familyIndex) * 3 + (slot - 1)]
    }
}
