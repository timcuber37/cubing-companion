/// Planner comfort, features, model, orientation, and presentation.

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

// MARK: - Comfort

public enum Comfort {
    /// Share of pro cross turns made on each face, in `FACE_SHARE`'s key order — which is also
    /// the order `score` sums in. See `comfort.ts`.
    public static let faceShare: [(family: String, share: Double)] = [
        ("D", 0.293), ("R", 0.292), ("F", 0.165), ("U", 0.127), ("L", 0.099), ("B", 0.025),
    ]
    private static let best = log(faceShare.map(\.share).max()!)
    private static let worst = log(faceShare.map(\.share).min()!)
    private static let logShares = faceShare.map { log($0.share) }
    private static let faceIndex: [String: Int] = Dictionary(
        uniqueKeysWithValues: faceShare.enumerated().map { ($1.family, $0) })

    /// How natural a sequence is to execute, 0 (all B turns) to 1 (all D turns).
    ///
    /// Summed per face in a fixed order, as the TypeScript now does, so that sequences turning the
    /// same faces tie exactly. Summed move by move, they differed in the last bit and the frame
    /// chosen between them came down to which `log` implementation was doing the rounding.
    public static func score(_ moves: [Move]) -> Double {
        guard !moves.isEmpty else { return 1 }
        var counts = [0, 0, 0, 0, 0, 0]
        var outside = 0
        for move in moves {
            if let i = faceIndex[move.family] { counts[i] += 1 } else { outside += 1 }
        }
        var total = 0.0
        for (i, logShare) in logShares.enumerated() { total += Double(counts[i]) * logShare }
        total += Double(outside) * worst
        return (total / Double(moves.count) - worst) / (best - worst)
    }

    public static func awkwardTurns(_ moves: [Move]) -> (back: Int, left: Int) {
        (moves.filter { $0.family == "B" }.count, moves.filter { $0.family == "L" }.count)
    }
}

// MARK: - Features

public enum Features {
    public static let crossNames = [
        "length", "comfort", "turnsU", "turnsD", "turnsL", "turnsR", "turnsF", "turnsB",
        "halfTurns", "distinctFaces", "endsOnDown", "sameAxisPairs",
    ]

    private static let axis: [String: String] = [
        "U": "y", "D": "y", "L": "x", "R": "x", "F": "z", "B": "z",
    ]

    /// What the cross ranker reads, in `CROSS_FEATURES` order.
    public static func cross(_ moves: [Move]) -> [Double] {
        func count(_ family: String) -> Double { Double(moves.filter { $0.family == family }.count) }
        var sameAxisPairs = 0
        for i in moves.indices.dropFirst() where axis[moves[i].family] == axis[moves[i - 1].family] {
            sameAxisPairs += 1
        }
        return [
            Double(moves.count),
            Comfort.score(moves),
            count("U"), count("D"), count("L"), count("R"), count("F"), count("B"),
            Double(moves.filter { $0.amount == 2 }.count),
            Double(Set(moves.map(\.family)).count),
            moves.last?.family == "D" ? 1 : 0,
            Double(sameAxisPairs),
        ]
    }
}

// MARK: - Model

public struct MlpLayer: Sendable {
    public let inputs: Int
    public let outputs: Int
    /// Row-major, `outputs × inputs`, as PyTorch stores `Linear.weight`.
    public let weight: [Double]
    public let bias: [Double]
}

/// `Linear → ReLU → … → Linear(·, 1)`, with standardisation carried as data. See `mlp.ts`.
public struct MlpWeights: Sendable {
    public let features: Int
    public let mean: [Double]
    public let scale: [Double]
    public let layers: [MlpLayer]

    public func score(_ row: [Double]) -> Double {
        precondition(row.count == features, "feature row has \(row.count) values, expected \(features)")
        var activations = (0..<features).map { (row[$0] - mean[$0]) / scale[$0] }
        for (index, layer) in layers.enumerated() {
            let last = index == layers.count - 1
            activations = (0..<layer.outputs).map { o in
                var sum = layer.bias[o]
                let offset = o * layer.inputs
                for i in 0..<layer.inputs { sum += layer.weight[offset + i] * activations[i] }
                return last ? sum : max(0, sum)
            }
        }
        return activations[0]
    }
}

// MARK: - Orientation

/// One of the 24 ways to hold the cube, and how moves are re-spelled when held that way.
public struct Orientation: Sendable {
    public let rotation: [Move]
    public let text: String
    /// `colourAt[slot]` is the colour of the centre that ends up in that slot.
    public let colourAt: [Int]
    let rename: [String: String]
    let renameRotation: [Move: Move]

    static let faceFamilies = ["U", "D", "L", "R", "F", "B"]
    static let amounts = [1, 2, -1]
    static let rotationMoves = ["x", "y", "z"].flatMap { f in amounts.map { Move(family: f, amount: $0) } }
    static let sliceMoves = ["M", "E", "S"].flatMap { f in amounts.map { Move(family: f, amount: $0) } }

    init(rotation: [Move]) {
        let solved = CubeState.solved
        let rotated = solved.applying(rotation)
        self.rotation = rotation
        text = Notation.write(rotation)
        colourAt = rotated.centers.map(Int.init)

        var rename: [String: String] = [:]
        for from in Self.faceFamilies {
            let target = solved.applying([Move(family: from, amount: 1)]).applying(rotation)
            rename[from] = Self.faceFamilies.first {
                rotated.applying([Move(family: $0, amount: 1)]) == target
            }!
        }
        self.rename = rename

        var renameRotation: [Move: Move] = [:]
        for from in Self.rotationMoves + Self.sliceMoves {
            let candidates = ["x", "y", "z"].contains(from.family) ? Self.rotationMoves : Self.sliceMoves
            let target = solved.applying([from]).applying(rotation)
            renameRotation[from] = candidates.first { rotated.applying([$0]) == target }!
        }
        self.renameRotation = renameRotation
    }

    /// All 24, breadth-first from standard. The order is observable — `bestFrame` keeps the first
    /// of equally comfortable frames — so it follows `ORIENTATIONS` exactly.
    public static let all: [Orientation] = {
        let solved = CubeState.solved
        var seen: Set<FixedBytes> = [solved.centers]
        var found: [[Move]] = [[]]
        var frontier: [[Move]] = [[]]
        while !frontier.isEmpty {
            var next: [[Move]] = []
            for path in frontier {
                for move in rotationMoves {
                    let rotation = path + [move]
                    guard seen.insert(solved.applying(rotation).centers).inserted else { continue }
                    found.append(rotation)
                    next.append(rotation)
                }
            }
            frontier = next
        }
        return found.map(Orientation.init)
    }()

    public static func withColourDown(_ colour: Int) -> [Orientation] {
        all.filter { $0.colourAt[Face.d.rawValue] == colour }
    }

    /// The same moves, as they are spelled when the cube is held this way.
    public func rename(_ moves: [Move]) -> [Move] {
        moves.map { move in
            if let mapped = renameRotation[move] { return mapped }
            if move.family.hasSuffix("w"), let base = rename[String(move.family.dropLast())] {
                return Move(family: base + "w", amount: move.amount)
            }
            guard let family = rename[move.family] else {
                preconditionFailure("cannot re-orient \(move.family)")
            }
            return Move(family: family, amount: move.amount)
        }
    }

    public func renameSlot(_ slot: String) -> String {
        String(slot.map { Character(rename[String($0)] ?? String($0)) })
    }

    /// Each rotation as a permutation of centre slots.
    private static let centrePerms: [(Move, [Int])] = rotationMoves.map { move in
        (move, CubeState.solved.applying([move]).centers.map(Int.init))
    }

    /// The shortest whole-cube rotation taking one centre arrangement to another.
    public static func rotationBetween(_ from: [Int], _ to: [Int]) -> [Move] {
        if from == to { return [] }
        var seen: Set<[Int]> = [from]
        var frontier: [([Int], [Move])] = [(from, [])]
        while !frontier.isEmpty {
            var next: [([Int], [Move])] = []
            for (centres, path) in frontier {
                for (move, perm) in centrePerms {
                    let after = perm.map { centres[$0] }
                    if after == to { return path + [move] }
                    guard seen.insert(after).inserted else { continue }
                    next.append((after, path + [move]))
                }
            }
            frontier = next
        }
        preconditionFailure("no rotation reaches \(to) from \(from)")
    }
}

// MARK: - Plans

public struct Hold: Sendable {
    public let down: Int
    public let front: Int
    public let rotation: String
}

public struct PlannedSolution: Sendable {
    public enum Kind: String, Sendable { case cross, xcross, crossPlusOne = "cross+1", crossPlusTwo = "cross+2" }
    public let kind: Kind
    public let crossFace: Int
    public var slot: String?
    public let searchSlot: String?
    public let slotLabel: String?
    public var setup: [Move]
    /// As the person will execute it, in the most comfortable frame.
    public var moves: [Move]
    /// As the solver found it, in the frame the cube was scrambled in.
    public let searchMoves: [Move]
    public var text: String { Notation.write(moves) }
    public var length: Int { moves.count }
    public var hold: Hold
    public var comfort: Double
    public var awkward: (back: Int, left: Int)
    public var modelScore: Double?
    public let steps: [PlanStep]?
    public let solvedPairLabels: [String]?
}

public struct PlanStep: Sendable {
    public let label: String
    public let text: String
}

public struct ColourPlan: Sendable {
    public let crossFace: Int
    public let cross: [PlannedSolution]
    public let xcross: [PlannedSolution]
    public let crossPlusOne: [PlannedSolution]?
    public let crossPlusTwo: [PlannedSolution]?
    public let crossLength: Int
    public let xcrossLength: Int
}

public enum Planner {
    /// The frame with this colour down that reads most comfortably; the first wins a tie.
    static func bestFrame(_ moves: [Move], _ crossFace: Int) -> (Orientation, [Move], Double) {
        var best: (Orientation, [Move], Double)?
        for orientation in Orientation.withColourDown(crossFace) {
            let renamed = orientation.rename(moves)
            let comfort = Comfort.score(renamed)
            if best == nil || comfort > best!.2 { best = (orientation, renamed, comfort) }
        }
        return best!
    }

    static func present(
        _ crossFace: Int, _ moves: [Move], _ startCentres: FixedBytes,
        frame: (Orientation, [Move], Double)? = nil,
        kind: PlannedSolution.Kind = .cross, slot: Slot? = nil,
        steps: [PlanStep]? = nil, solvedPairLabels: [String]? = nil
    ) -> PlannedSolution {
        let (orientation, framed, comfort) = frame ?? bestFrame(moves, crossFace)
        return PlannedSolution(
            kind: kind,
            crossFace: crossFace,
            slot: slot.map { orientation.renameSlot($0.name) },
            searchSlot: slot?.name,
            slotLabel: slot.map(Colours.slot),
            setup: Orientation.rotationBetween(startCentres.map(Int.init), orientation.colourAt),
            moves: framed,
            searchMoves: moves,
            hold: Hold(
                down: orientation.colourAt[Face.d.rawValue],
                front: orientation.colourAt[Face.f.rawValue],
                rotation: orientation.text),
            comfort: comfort,
            awkward: Comfort.awkwardTurns(framed),
            modelScore: nil,
            steps: steps,
            solvedPairLabels: solvedPairLabels)
    }

    /// Shortest first, then most comfortable; otherwise enumeration order, which JavaScript's
    /// stable sort preserves and Swift's `sort` does not promise to.
    static func ranked(_ plans: [PlannedSolution]) -> [PlannedSolution] {
        plans.enumerated().sorted { a, b in
            if a.element.length != b.element.length { return a.element.length < b.element.length }
            if a.element.comfort != b.element.comfort { return a.element.comfort > b.element.comfort }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// `planColour` with `crossOnly: true`.
    public static func planCross(
        _ state: CubeState, _ crossFace: Int, keep: Int = 3, maxExtra: Int = 0,
        maxSolutions: Int = 200, deadlineMs: Double? = nil
    ) -> ColourPlan {
        var options = SearchOptions()
        options.maxExtra = maxExtra
        options.maxSolutions = maxSolutions
        options.deadlineMs = deadlineMs
        let result = enumerateCross(state, crossFace, options)
        // Grip scoring is needed for the rank, but setup rotation and the full presented plan
        // are needed only for the few candidates that survive `keep`.
        let ranked = result.candidates.enumerated().map { index, candidate in
            (index: index, moves: candidate.moves, frame: bestFrame(candidate.moves, crossFace))
        }.sorted { a, b in
            if a.moves.count != b.moves.count { return a.moves.count < b.moves.count }
            if a.frame.2 != b.frame.2 { return a.frame.2 > b.frame.2 }
            return a.index < b.index
        }
        let cross = ranked.prefix(keep).map {
            present(crossFace, $0.moves, state.centers, frame: $0.frame)
        }
        return ColourPlan(
            crossFace: crossFace, cross: cross, xcross: [], crossPlusOne: nil,
            crossPlusTwo: nil, crossLength: result.optimal, xcrossLength: -1)
    }

    /// Full colour plan, including all four joint cross/pair goals.
    public static func planColour(
        _ state: CubeState, _ crossFace: Int, keep: Int = 3, maxExtra: Int = 0,
        maxSolutions: Int = 200, crossOnly: Bool = false, lookahead: Bool = false,
        deadlineMs: Double? = nil
    ) -> ColourPlan {
        var crossOptions = SearchOptions()
        crossOptions.maxExtra = maxExtra
        crossOptions.maxSolutions = maxSolutions
        crossOptions.deadlineMs = deadlineMs
        let crossResult = enumerateCross(state, crossFace, crossOptions)
        let rankedCross = rankCandidates(crossResult.candidates, crossFace, state.centers, keep: keep)
        let xcrossOptions: SearchOptions = {
            var options = crossOptions
            if lookahead {
                options.maxExtra = max(1, maxExtra)
                options.maxSolutionsPerDepth = 8
                options.maxSolutions = 16
                options.maxNodes = 150_000
            }
            return options
        }()
        var xcross: [PlannedSolution] = []
        var rankedXcross: [(index: Int, moves: [Move], slot: Slot, frame: (Orientation, [Move], Double))] = []
        if !crossOnly {
            var index = 0
            for (slot, result) in zip(geometry[crossFace].slots,
                                      enumerateAllXcrosses(state, crossFace, options: xcrossOptions)) {
                for candidate in result.candidates {
                    rankedXcross.append((index, candidate.moves, slot,
                                         bestFrame(candidate.moves, crossFace)))
                    index += 1
                }
            }
            rankedXcross.sort { a, b in
                if a.moves.count != b.moves.count { return a.moves.count < b.moves.count }
                if a.frame.2 != b.frame.2 { return a.frame.2 > b.frame.2 }
                return a.index < b.index
            }
            xcross = rankedXcross.prefix(keep).map {
                present(crossFace, $0.moves, state.centers, frame: $0.frame,
                        kind: .xcross, slot: $0.slot)
            }
        }
        var plusOne: [PlannedSolution]?
        var plusTwo: [PlannedSolution]?
        if lookahead && !crossOnly {
            let openings = Openings.search(state, crossFace, xcrosses: rankedXcross.map(\.moves))
            func presentOpening(_ opening: Openings.Opening, _ kind: PlannedSolution.Kind) -> PlannedSolution {
                let frame = bestFrame(opening.moves, crossFace)
                let steps = opening.steps.map {
                    PlanStep(label: $0.label, text: Notation.write(frame.0.rename($0.moves)))
                }
                let labels = opening.solvedSlots.map { name in
                    Colours.slot(geometry[crossFace].slots.first { $0.name == name }!)
                }
                return present(crossFace, opening.moves, state.centers, frame: frame,
                               kind: kind, steps: steps, solvedPairLabels: labels)
            }
            plusOne = Array(ranked(openings.crossPlusOne.map { presentOpening($0, .crossPlusOne) }).prefix(keep))
            plusTwo = Array(ranked(openings.crossPlusTwo.map { presentOpening($0, .crossPlusTwo) }).prefix(keep))
        }
        return ColourPlan(
            crossFace: crossFace, cross: rankedCross, xcross: xcross,
            crossPlusOne: plusOne, crossPlusTwo: plusTwo, crossLength: crossResult.optimal,
            xcrossLength: rankedXcross.first?.moves.count ?? -1)
    }

    private static func rankCandidates(
        _ candidates: [Candidate], _ face: Int, _ centres: FixedBytes, keep: Int
    ) -> [PlannedSolution] {
        let ranked = candidates.enumerated().map { index, candidate in
            (index: index, moves: candidate.moves, frame: bestFrame(candidate.moves, face))
        }.sorted { a, b in
            if a.moves.count != b.moves.count { return a.moves.count < b.moves.count }
            if a.frame.2 != b.frame.2 { return a.frame.2 > b.frame.2 }
            return a.index < b.index
        }
        return ranked.prefix(keep).map { present(face, $0.moves, centres, frame: $0.frame) }
    }
}
