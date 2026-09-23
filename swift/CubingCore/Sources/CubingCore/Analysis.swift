/// CFOP phase segmentation from cube state — the Swift counterpart of `packages/analysis`.
///
/// Ported line for line from `geometry.ts`, `phases.ts` and `segment.ts`, including the order the
/// algorithm does things in. That order was arrived at by measuring against the reconstruction
/// corpus, and the comments in `segment.ts` explain why each step is where it is; they are not
/// repeated here, only pointed at where a Swift detail differs.

// MARK: - Geometry

/// Piece names, in engine slot order. Only the letters matter: they say which faces a piece
/// touches.
let cornerNames = ["URF", "UBR", "ULB", "UFL", "DFR", "DLF", "DBL", "DRB"]
public let edgeNames = ["UF", "UR", "UB", "UL", "DF", "DR", "DB", "DL", "FR", "FL", "BR", "BL"]

private let faceLetters = Array("ULFRBD")
private func faces(of name: String) -> [Int] { name.map { faceLetters.firstIndex(of: $0)! } }
private let cornerFaces = cornerNames.map(faces)
private let edgeFaces = edgeNames.map(faces)

/// Indexed by `Face` raw value: U↔D, L↔R, F↔B.
private let opposite = [5, 3, 4, 1, 2, 0]

/// An F2L slot: a cross-layer corner and the middle-layer edge sharing its two side faces.
public struct Slot: Equatable, Sendable {
    public let corner: Int
    public let edge: Int
    public let faces: (Int, Int)

    public var name: String { edgeNames[edge] }

    public static func == (a: Slot, b: Slot) -> Bool { a.corner == b.corner && a.edge == b.edge }
}

public struct CrossGeometry: Sendable {
    public let crossFace: Int
    public let lastLayerFace: Int
    public let crossEdges: [Int]
    public let slots: [Slot]
    public let f2lCorners: [Int]
    public let f2lEdges: [Int]
    public let llCorners: [Int]
    public let llEdges: [Int]

    init(crossFace: Int) {
        let lastLayer = opposite[crossFace]
        self.crossFace = crossFace
        lastLayerFace = lastLayer
        crossEdges = edgeFaces.indices.filter { edgeFaces[$0].contains(crossFace) }
        f2lCorners = cornerFaces.indices.filter { !cornerFaces[$0].contains(lastLayer) }
        f2lEdges = edgeFaces.indices.filter { !edgeFaces[$0].contains(lastLayer) }
        llCorners = cornerFaces.indices.filter { cornerFaces[$0].contains(lastLayer) }
        llEdges = edgeFaces.indices.filter { edgeFaces[$0].contains(lastLayer) }

        let crossEdges = self.crossEdges
        let middleEdges = f2lEdges.filter { !crossEdges.contains($0) }
        slots = f2lCorners.map { corner in
            let sides = cornerFaces[corner].filter { $0 != crossFace }
            let edge = middleEdges.first { e in sides.allSatisfy { edgeFaces[e].contains($0) } }!
            return Slot(corner: corner, edge: edge, faces: (sides[0], sides[1]))
        }
    }
}

/// One geometry per cross face, indexed by `Face` raw value.
public let geometry: [CrossGeometry] = (0..<numCenters).map(CrossGeometry.init)

// MARK: - Phase predicates

/// A quarter turn of each face, indexed by `Face` raw value.
private let faceTurns: [Transformation] = faceLetters.map {
    MoveTables.transformation(for: Move(family: String($0), amount: 1))!
}

private func isPieceSolved(_ state: CubeState, corners: [Int], edges: [Int]) -> Bool {
    corners.allSatisfy { state.cp[$0] == $0 && state.co[$0] == 0 }
        && edges.allSatisfy { state.ep[$0] == $0 && state.eo[$0] == 0 }
}

/// How many quarter turns of the cross face bring the cross home, or nil if it is not built.
public func crossOffset(_ state: CubeState, _ geometry: CrossGeometry) -> Int? {
    let turn = faceTurns[geometry.crossFace]
    var candidate = state
    for offset in 0..<4 {
        if isPieceSolved(candidate, corners: [], edges: geometry.crossEdges) { return offset }
        candidate = candidate.applying(turn)
    }
    return nil
}

public func isCrossBuilt(_ state: CubeState, _ geometry: CrossGeometry) -> Bool {
    crossOffset(state, geometry) != nil
}

public func alignCross(_ state: CubeState, _ geometry: CrossGeometry) -> CubeState? {
    guard let offset = crossOffset(state, geometry) else { return nil }
    var aligned = state
    for _ in 0..<offset { aligned = aligned.applying(faceTurns[geometry.crossFace]) }
    return aligned
}

public func isSlotSolved(_ state: CubeState, _ slot: Slot) -> Bool {
    isPieceSolved(state, corners: [slot.corner], edges: [slot.edge])
}

public func isF2LComplete(_ state: CubeState, _ geometry: CrossGeometry) -> Bool {
    isPieceSolved(state, corners: geometry.f2lCorners, edges: geometry.f2lEdges)
}

/// Whether a face shows a single colour — checked on the facelets, as the TypeScript does.
public func isFaceUniform(_ state: CubeState, _ face: Int) -> Bool {
    let facelets = Array(Facelets.string(from: state))
    let start = Facelets.faceToStringIndex[face] * 9
    return facelets[start..<start + 9].allSatisfy { $0 == facelets[start] }
}

public func isLastLayerOriented(_ state: CubeState, _ geometry: CrossGeometry) -> Bool {
    isFaceUniform(state, geometry.lastLayerFace)
}

public func isSolvedIgnoringAUF(_ state: CubeState, _ geometry: CrossGeometry) -> Bool {
    var candidate = state
    for _ in 0..<4 {
        if candidate == .solved { return true }
        candidate = candidate.applying(faceTurns[geometry.lastLayerFace])
    }
    return false
}

// MARK: - Segmentation

public enum Phase: String, Sendable, CaseIterable {
    case cross, f2l1, f2l2, f2l3, f2l4, oll, pll, auf
}

public struct PhaseSpan: Sendable {
    public let phase: Phase
    public let start: Int
    public let end: Int
    public let moves: [Move]
    /// Non-rotation moves, i.e. the slice turn metric for this phase.
    public let turns: Int
    public let rotations: Int
    /// Which F2L slot this span filled, for the F2L phases.
    public let slot: String?
}

public struct SolveSegmentation: Sendable {
    public let crossFace: Int
    public let spans: [PhaseSpan]
    public let xcross: Bool
    public let freePairs: Int
    public let pseudoCross: Bool
    public let crossOffsetAtEnd: Int
    public let skips: [Phase]
    public let totalTurns: Int
    public let totalRotations: Int
}

public enum SegmentationFailure: String, Sendable {
    case doesNotSolve = "does-not-solve"
    case noCrossFound = "no-cross-found"
    case noF2LFound = "no-f2l-found"
}

public enum Segmentation {
    public struct Result: Sendable {
        public let segmentation: SolveSegmentation?
        public let failure: SegmentationFailure?
        public let detail: String?

        static func failed(_ failure: SegmentationFailure, _ detail: String?) -> Result {
            Result(segmentation: nil, failure: failure, detail: detail)
        }
    }

    static func isRotation(_ move: Move) -> Bool {
        move.family == "x" || move.family == "y" || move.family == "z"
    }

    public static func segment(
        scramble: [Move], solution: [Move], trailingRotationsEndPhase: Bool = true
    ) -> Result {
        segment(
            from: .after(scramble), solution: solution,
            trailingRotationsEndPhase: trailingRotationsEndPhase
        )
    }

    /// Segment a solve from the position it actually started in. See `segmentFromState`.
    public static func segment(
        from scrambled: CubeState, solution: [Move], trailingRotationsEndPhase: Bool = true
    ) -> Result {
        guard scrambled.applying(solution).isSolvedIgnoringOrientation else {
            return .failed(.doesNotSolve, "scramble + solution does not reach a solved cube")
        }

        var trace = [scrambled.normalized]
        var running = scrambled
        for move in solution {
            running = running.applying([move])
            trace.append(running.normalized)
        }

        func firstIndex(from: Int = 0, _ predicate: (CubeState) -> Bool) -> Int? {
            guard from < trace.count else { return nil }
            return (from..<trace.count).first { predicate(trace[$0]) }
        }

        // The cross colour is the one whose F2L completes earliest; strict `<` keeps the first
        // face on a tie, as the TypeScript does.
        var found: (geometry: CrossGeometry, f2lIndex: Int)?
        for candidate in geometry {
            guard let index = firstIndex({ isF2LComplete($0, candidate) }) else { continue }
            if found == nil || index < found!.f2lIndex { found = (candidate, index) }
        }
        guard let (geometry, f2lIndex) = found else {
            return .failed(.noF2LFound, "no cross colour reached a completed F2L")
        }

        guard let builtIndex = firstIndex({ crossOffset($0, geometry) != nil }) else {
            return .failed(.noCrossFound, nil)
        }
        let alignedIndex = firstIndex { crossOffset($0, geometry) == 0 }

        // Sorted by completion index with the slot's own position as tie-break: Array.sort is not
        // documented as stable, and JavaScript's is.
        let slotCompletion = geometry.slots.enumerated().map { order, slot in
            let index = firstIndex(from: builtIndex) { state in
                guard let aligned = alignCross(state, geometry) else { return false }
                return isSlotSolved(aligned, slot)
            }
            return (slot: slot, index: index ?? f2lIndex, order: order)
        }.sorted { ($0.index, $0.order) < ($1.index, $1.order) }

        let alignPoint = alignedIndex ?? f2lIndex
        let earliestPair = slotCompletion.first?.index ?? f2lIndex
        let workedOffset = earliestPair < alignPoint
        let crossIndex = workedOffset ? builtIndex : alignPoint

        let freePairs = slotCompletion.filter { $0.index <= alignPoint }.count
        let crossOffsetAtEnd = crossOffset(trace[crossIndex], geometry) ?? 0

        let ollIndex = firstIndex(from: f2lIndex) { isLastLayerOriented($0, geometry) }
        let pllIndex = firstIndex(from: ollIndex ?? f2lIndex) { isSolvedIgnoringAUF($0, geometry) }

        let boundaries =
            [crossIndex] + slotCompletion.map(\.index)
            + [ollIndex ?? f2lIndex, pllIndex ?? solution.count, solution.count]

        let adjusted =
            trailingRotationsEndPhase
            ? boundaries.enumerated().map { i, boundary in
                // The last boundary is the end of the solve; nothing follows to absorb.
                guard i < boundaries.count - 1 else { return boundary }
                var end = boundary
                while end < boundaries[i + 1], isRotation(solution[end]) { end += 1 }
                return end
            }
            : boundaries

        var spans: [PhaseSpan] = []
        var start = 0
        for (i, phase) in Phase.allCases.enumerated() {
            let end = adjusted[i]
            // Deliberately unclamped, as in the TypeScript: a backwards span is a visible fault.
            let moves = start <= end ? Array(solution[start..<end]) : []
            let rotations = moves.filter(isRotation).count
            spans.append(
                PhaseSpan(
                    phase: phase, start: start, end: end, moves: moves,
                    turns: moves.count - rotations, rotations: rotations,
                    slot: (1...4).contains(i) ? slotCompletion[i - 1].slot.name : nil
                ))
            start = end
        }

        let totalRotations = solution.filter(isRotation).count
        return Result(
            segmentation: SolveSegmentation(
                crossFace: geometry.crossFace,
                spans: spans,
                xcross: freePairs >= 1,
                freePairs: freePairs,
                pseudoCross: crossOffsetAtEnd != 0,
                crossOffsetAtEnd: crossOffsetAtEnd,
                skips: spans.filter { $0.turns == 0 }.map(\.phase),
                totalTurns: solution.count - totalRotations,
                totalRotations: totalRotations
            ),
            failure: nil, detail: nil)
    }
}
