/// Reviewing solves: the decision diff, "which pair next", and the grip a replay is shown from —
/// the Swift counterparts of `decisions.ts`, `explain.ts`, `grip.ts` and `review.ts` in
/// `packages/planner`.
///
/// Two kinds of feedback, kept apart as the TypeScript keeps them: **choice**, from the model, is a
/// distribution and never a verdict; **execution**, from the search, is a fact. See `review.ts`.

import Foundation

// MARK: - Grip

/// Which way the cube was held, inferred from which faces were turned — nobody turns B during F2L,
/// so a solve full of B turns in the cube's own frame was being held some other way.
public enum Grip {
    public enum Group: CaseIterable, Sendable { case cross, f2l, lastLayer }

    /// Share of turns on each face, per phase group, from the corpus. See `grip.ts`.
    static let faceShare: [Group: [String: Double]] = [
        .cross: ["U": 0.1774, "D": 0.285, "L": 0.0937, "R": 0.2843, "F": 0.1404, "B": 0.0192],
        .f2l: ["U": 0.4608, "D": 0.0083, "L": 0.1378, "R": 0.3684, "F": 0.0245, "B": 0.0002],
        .lastLayer: ["U": 0.4421, "D": 0.0348, "L": 0.0253, "R": 0.4079, "F": 0.088, "B": 0.002],
    ]
    static let faceOrder = ["U", "D", "L", "R", "F", "B"]

    public static func group(_ phase: Phase) -> Group? {
        switch phase {
        case .cross: .cross
        case .f2l1, .f2l2, .f2l3, .f2l4: .f2l
        case .oll, .pll: .lastLayer
        case .auf: nil  // a single U turn by definition, and says nothing about the grip
        }
    }

    public struct Observation: Sendable, Equatable {
        public let face: String
        public let group: Group
    }

    public static func observations(_ spans: [PhaseSpan]) -> [Observation] {
        spans.flatMap { span -> [Observation] in
            guard let group = group(span.phase) else { return [] }
            // Rotations say nothing on their own, and wide and slice moves are not in the model.
            return span.moves.compactMap { faceShare[group]![$0.family] == nil ? nil : Observation(face: $0.family, group: group) }
        }
    }

    /// The four frames that put `colour` down, from a position whose centres are `centres`.
    public static func framesPuttingColourDown(_ centres: [Int], _ colour: Int) -> [Orientation] {
        Orientation.all.filter { centres[$0.colourAt[Face.d.rawValue]] == colour }
    }

    /// The most likely grip. Summed per face in a fixed order, as `inferGrip` now is, so grips that
    /// see the same faces tie exactly and the first wins, rather than whichever rounding favours.
    public static func infer(_ observations: [Observation], _ candidates: [Orientation]) -> Orientation {
        precondition(!candidates.isEmpty, "no candidate grips to choose between")
        guard !observations.isEmpty else { return candidates[0] }
        var counts: [Group: [String: Int]] = [:]
        for o in observations { counts[o.group, default: [:]][o.face, default: 0] += 1 }

        var best = candidates[0]
        var bestScore = -Double.infinity
        for candidate in candidates {
            var score = 0.0
            for group in Group.allCases {
                for face in faceOrder {
                    guard let count = counts[group]?[face] else { continue }
                    let seen = candidate.rename[face]
                    let share = seen.flatMap { faceShare[group]![$0] }
                    score += Double(count) * log(share ?? Double.leastNonzeroMagnitude)
                }
            }
            if score > bestScore {
                bestScore = score
                best = candidate
            }
        }
        return best
    }
}

// MARK: - Decisions

public struct PairOption: Sendable {
    public let slot: Slot
    public let name: String
    public let optimal: Int
    public let ways: Int
    public let bestMoves: [Move]
    public let features: [Double]
}

public struct PairDecision: Sendable {
    public let step: Int
    public let at: Int
    /// Normalised: the frame every search result is expressed in.
    public let state: CubeState
    public let options: [PairOption]
    public let chosen: Int
    public let playedMoves: [Move]
}

public struct CrossDecision: Sendable {
    public let at: Int
    public let end: Int
    public let state: CubeState
    public let played: Int
    public let playedMoves: [Move]
    public let optimal: Int
}

public enum Decisions {
    /// The cap on insertions counted per slot; `ways` saturates here.
    public static let waysCap = 60

    /// The pair choices a solve made, each with every alternative the position offered.
    public static func pairs(_ start: CubeState, _ solution: [Move], _ spans: [PhaseSpan], _ crossFace: Int) -> [PairDecision] {
        let g = geometry[crossFace]
        let bySlotName = Dictionary(uniqueKeysWithValues: g.slots.map { ($0.name, $0) })
        let phases = [Phase.f2l1, .f2l2, .f2l3, .f2l4].map { phase in spans.first { $0.phase == phase } }
        guard phases.allSatisfy({ $0?.slot != nil }) else { return [] }

        var decisions: [PairDecision] = []
        for step in 0..<3 {
            let span = phases[step]!
            let state = start.applying(Array(solution[0..<span.start])).normalized
            if crossDistance(state, crossFace) != 0 { break }
            let open = g.slots.filter { !isSlotSolved(state, $0) }
            if open.count != 4 - step { break }
            guard let chosenSlot = bySlotName[span.slot!], open.contains(chosenSlot) else { break }

            var options = SearchOptions()
            options.maxSolutions = waysCap
            let searched = open.map { slot -> Ranker.PairCandidate in
                let result = enumerateF2LInsertion(state, crossFace, slot, options: options)
                return Ranker.PairCandidate(
                    slot: slot, optimal: result.optimal, ways: result.candidates.count,
                    bestMoves: result.candidates.first?.moves ?? [])
            }
            // A slot the search could not reach makes the whole decision unusable.
            if searched.contains(where: { $0.optimal < 0 }) { break }

            let bestLength = searched.map(\.optimal).min()!
            let previous = step > 0 ? bySlotName[phases[step - 1]!.slot!] : nil
            decisions.append(
                PairDecision(
                    step: step, at: span.start, state: state,
                    options: searched.map { candidate in
                        PairOption(
                            slot: candidate.slot, name: candidate.slot.name, optimal: candidate.optimal,
                            ways: candidate.ways, bestMoves: candidate.bestMoves,
                            features: Ranker.pairFeatures(
                                state, g, candidate, bestLength: bestLength, previous: previous,
                                step: step, openCount: open.count))
                    },
                    chosen: searched.firstIndex { $0.slot == chosenSlot }!,
                    playedMoves: span.moves))
        }
        return decisions
    }

    public static func cross(_ start: CubeState, _ solution: [Move], _ spans: [PhaseSpan], optimal: Int) -> CrossDecision? {
        guard let span = spans.first(where: { $0.phase == .cross }), span.end != span.start else { return nil }
        return CrossDecision(
            at: span.start, end: span.end,
            state: start.applying(Array(solution[0..<span.start])).normalized,
            played: span.turns, playedMoves: span.moves, optimal: optimal)
    }
}

// MARK: - Explanations

public enum Explain {
    public struct Attribution: Sendable {
        public let feature: String
        public let delta: Double
        public let share: Double
        public let yours: Double
        public let theirs: Double
    }

    /// Why the model prefers theirs: its score with one of your features swapped for theirs at a
    /// time, against the gap between the two. Empty when it does not actually prefer theirs.
    public static func attribute(_ yours: [Double], _ theirs: [Double], score: ([Double]) -> Double) -> [Attribution] {
        let mine = score(yours)
        let gap = score(theirs) - mine
        guard gap > 0 else { return [] }
        var all: [Attribution] = []
        for (i, feature) in Ranker.pairFeatureNames.enumerated() {
            var swapped = yours
            swapped[i] = theirs[i]
            let delta: Double = score(swapped) - mine
            all.append(
                Attribution(
                    feature: feature, delta: delta, share: max(0, min(1, delta / gap)),
                    yours: yours[i], theirs: theirs[i]))
        }
        let kept: [(offset: Int, element: Attribution)] = all.enumerated()
            .filter { $0.element.delta > 0 && $0.element.yours != $0.element.theirs }
            .map { (offset: $0.offset, element: $0.element) }
        // Largest effect first; stably, as JavaScript sorts.
        return kept.sorted { a, b in
            a.element.delta == b.element.delta ? a.offset < b.offset : a.element.delta > b.element.delta
        }.map(\.element)
    }

    /// A number as JavaScript prints it in a template string: `6`, not `6.0`.
    private static func js(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    public static func phrase(_ a: Attribution, yours: String, theirs: String) -> String {
        let up = a.theirs > a.yours, down = a.theirs < a.yours
        switch a.feature {
        case "cornerOnTop":
            return up ? "\(theirs)'s corner was already up top where you can see it, while \(yours)'s was buried in a slot"
                : "\(yours)'s corner was buried, and \(theirs)'s was not"
        case "edgeOnTop":
            return up ? "\(theirs)'s edge was up top rather than stuck in a slot" : "\(yours)'s edge was the one still in a slot"
        case "cornerInOwnSlot":
            return up ? "\(theirs)'s corner was already home, only twisted" : "\(yours)'s corner was sitting in the wrong slot"
        case "edgeInOwnSlot":
            return up ? "\(theirs)'s edge was already home, only flipped" : "\(yours)'s edge was in the wrong slot"
        case "insertionLength":
            return down ? "it goes in in \(js(a.theirs)) moves against \(js(a.yours)) for \(yours)"
                : "it costs \(js(a.theirs)) moves to \(yours)'s \(js(a.yours)), and is still the one to take"
        case "excessOverBest":
            return down ? "it was the cheapest pair on the cube; yours cost \(js(a.yours)) more"
                : "it was not the cheapest, by \(js(a.theirs)) moves"
        case "pairDistance":
            return down ? "\(theirs)'s two pieces were closer to being joined"
                : "\(theirs)'s pieces were further apart, and it was still worth doing first"
        case "logWays":
            return down ? "there was one clear way to insert \(theirs), rather than several to choose between"
                : "\(theirs) could be inserted more ways, leaving room to pick a comfortable one"
        case "backTurns":
            return down ? "it needs no back-face turns, while \(yours) needs \(js(a.yours))"
                : "it needs \(js(a.theirs)) back turns and is still the better pair"
        case "adjacentToPrevious":
            return up ? "\(theirs) sits beside the pair you had just finished, so your hands were already there"
                : "it moves away from the pair you had just finished"
        case "stepIndex":
            return "it was pair \(js(a.theirs + 1)) rather than pair \(js(a.yours + 1))"
        case "openCount":
            return "there were \(js(a.theirs)) slots open rather than \(js(a.yours))"
        default:
            return a.feature
        }
    }

    public static func reasons(_ attributions: [Attribution], yours: String, theirs: String, limit: Int = 2) -> [String] {
        attributions.filter { $0.share > 0.05 }.prefix(limit).map { phrase($0, yours: yours, theirs: theirs) }
    }

    public static func confidenceWording(_ confidence: Double) -> String {
        if confidence >= 0.6 { return "would most likely take" }
        if confidence >= 0.4 { return "would more often take" }
        return "leans slightly towards"
    }
}

// MARK: - Review

public struct PairForecast: Codable, Sendable, Equatable {
    public struct Step: Codable, Sendable, Equatable {
        public let label: String
        public let moves: String
    }
    public let depth: Int
    public let immediateTurns: Int
    public let totalTurns: Int
    public let solvedPairs: Int
    public let branch: String
    public let steps: [Step]
}

public struct RankedPair: Codable, Sendable {
    public let slot: String
    public let label: String
    public let optimal: Int
    public let moves: String
    public let confidence: Double
    public let lookahead: PairForecast?
}

public struct DiffOption: Codable, Sendable {
    public let slot: String
    public let label: String
    public let optimal: Int
    public let setup: String
    public let moves: String
    public let confidence: Double
    public let mine: Bool
}

public struct PairDiff: Codable, Sendable {
    public struct Lookahead: Codable, Sendable {
        public let label: String
        public let forecast: PairForecast
    }
    public let step: Int
    /// Index into the solution where this decision was made.
    public let at: Int
    public let yours: String
    public let theirs: String
    public let options: [DiffOption]
    public let wording: String
    public let reasons: [String]
    public let playedTurns: Int
    public let optimalTurns: Int
    public let played: String
    /// Theirs, executable from the position at `at`.
    public let branch: String
    public let lookahead: Lookahead?
}

public struct CrossDiff: Codable, Sendable {
    public struct Opening: Codable, Sendable {
        public let label: String
        public let turns: Int
        public let branch: String
    }
    public let at: Int
    public let end: Int
    public let playedTurns: Int
    public let optimalTurns: Int
    public let setup: String
    public let best: String
    public let hold: String
    public let branch: String
    public let lookahead: Opening?
}

public struct SolveDiff: Codable, Sendable {
    public let cross: CrossDiff?
    public let pairs: [PairDiff]
    public let learned: Bool
    public let failure: String?
}

public struct NextPairs: Codable, Sendable {
    public let crossFace: Int?
    public let ranked: [RankedPair]
    public let learned: Bool
}

public enum Review {
    /// The model's two heads; either may be missing, and the review degrades rather than fails.
    public struct Scorers: Sendable {
        public let cross: MlpWeights?
        public let pair: MlpWeights?

        public init(cross: MlpWeights?, pair: MlpWeights?) {
            self.cross = cross
            self.pair = pair
        }

        public static var bundled: Scorers { Scorers(cross: Weights.cross, pair: Weights.pair) }
    }

    /// The rotations into the normalised frame, prefixed so a suggestion is executable from the
    /// position the cube was really in. Empty for a smart cube, whose centres never move.
    public static func normalisingSetup(_ centres: [Int]) -> [Move] {
        Orientation.rotationBetween(centres, [0, 1, 2, 3, 4, 5])
    }

    public static func forecast(_ plan: Lookahead.Continuation, _ crossFace: Int, depth: Int, setup: [Move]) -> PairForecast {
        let slots = geometry[crossFace].slots
        return PairForecast(
            depth: depth, immediateTurns: plan.steps.first?.moves.count ?? 0,
            totalTurns: plan.moves.count, solvedPairs: plan.solvedSlots.count,
            branch: Notation.write(setup + plan.moves),
            steps: plan.steps.enumerated().map { i, step in
                PairForecast.Step(
                    label: Colours.slot(slots.first { $0.name == step.slot }!),
                    moves: Notation.write(i == 0 ? setup + step.moves : step.moves))
            })
    }

    /// A5: at each decision of a recorded solve, what a top solver would likely have done.
    ///
    /// - Parameter stillWanted: checked between decisions; returns nil if it answers false.
    public static func diff(
        _ start: CubeState, _ solution: [Move], scorers: Scorers = .bundled,
        stillWanted: () -> Bool = { true }
    ) -> SolveDiff? {
        guard let segmentation = Segmentation.segment(from: start, solution: solution).segmentation else {
            return SolveDiff(
                cross: nil, pairs: [], learned: false,
                failure: "this solve could not be segmented, so there are no decisions to compare")
        }
        let spans = segmentation.spans
        let crossFace = segmentation.crossFace

        var crossOptions = SearchOptions()
        crossOptions.maxSolutions = 1
        let optimal = enumerateCross(start.normalized, crossFace, crossOptions).optimal
        var cross: CrossDiff?
        if let part = Decisions.cross(start, solution, spans, optimal: optimal) {
            // From the raw position at the decision, so the setup is relative to where the cube was.
            let raw = start.applying(Array(solution[0..<part.at]))
            let plan = Planner.planColour(raw, crossFace, keep: 3, lookahead: true)
            let ranked = scorers.cross.map { weights in
                Ranker.rerankCross(plan.cross, startCentres: raw.centers, score: weights.score)
            } ?? plan.cross
            let best = ranked.first
            let opening = plan.crossPlusTwo?.first ?? plan.crossPlusOne?.first
            cross = CrossDiff(
                at: part.at, end: part.end, playedTurns: part.played, optimalTurns: part.optimal,
                setup: best.map { Notation.write($0.setup) } ?? "", best: best?.text ?? "",
                hold: best.map { "\(Colours.name($0.hold.down)) down, \(Colours.name($0.hold.front)) front" } ?? "",
                branch: best.map { Notation.write($0.setup + $0.moves) } ?? "",
                lookahead: opening.map {
                    CrossDiff.Opening(
                        label: $0.kind == .crossPlusTwo ? "cross + 2 pairs" : "cross + 1 pair",
                        turns: $0.length, branch: Notation.write($0.setup + $0.moves))
                })
        }

        var pairs: [PairDiff] = []
        for decision in Decisions.pairs(start, solution, spans, crossFace) {
            guard stillWanted() else { return nil }
            let yours = decision.options[decision.chosen]
            let playedTurns = decision.playedMoves.filter { !Segmentation.isRotation($0) }.count
            let setup = normalisingSetup(start.applying(Array(solution[0..<decision.at])).centers.map(Int.init))
            let setupText = Notation.write(setup)
            let deeper = Lookahead.pairs(decision.state, crossFace)
            let lookahead = deeper.options.first { $0.plan != nil }.map {
                PairDiff.Lookahead(
                    label: Colours.slot($0.slot), forecast: forecast($0.plan!, crossFace, depth: deeper.depth, setup: setup))
            }

            guard let weights = scorers.pair else {
                // Without the model there is no "which pair" advice; the execution half still holds.
                pairs.append(
                    PairDiff(
                        step: decision.step, at: decision.at, yours: Colours.slot(yours.slot),
                        theirs: Colours.slot(yours.slot),
                        options: decision.options.map {
                            DiffOption(
                                slot: $0.name, label: Colours.slot($0.slot), optimal: $0.optimal, setup: setupText,
                                moves: Notation.write($0.bestMoves), confidence: 0, mine: $0.slot == yours.slot)
                        },
                        wording: "", reasons: [], playedTurns: playedTurns, optimalTurns: yours.optimal,
                        played: Notation.write(decision.playedMoves), branch: Notation.write(setup + yours.bestMoves),
                        lookahead: lookahead))
                continue
            }

            let ranked = Ranker.rankNextPair(
                decision.state, geometry[crossFace],
                candidates: decision.options.map {
                    Ranker.PairCandidate(slot: $0.slot, optimal: $0.optimal, ways: $0.ways, bestMoves: $0.bestMoves)
                },
                context: Ranker.PairContext(previous: nil, step: decision.step), score: weights.score)
            let theirs = decision.options.first { $0.slot == ranked[0].slot }!
            pairs.append(
                PairDiff(
                    step: decision.step, at: decision.at, yours: Colours.slot(yours.slot),
                    theirs: Colours.slot(theirs.slot),
                    options: ranked.map { entry in
                        let option = decision.options.first { $0.slot == entry.slot }!
                        return DiffOption(
                            slot: option.name, label: Colours.slot(option.slot), optimal: option.optimal,
                            setup: setupText, moves: Notation.write(option.bestMoves),
                            confidence: entry.confidence, mine: option.slot == yours.slot)
                    },
                    wording: Explain.confidenceWording(ranked[0].confidence),
                    reasons: theirs.slot == yours.slot
                        ? []
                        : Explain.reasons(
                            Explain.attribute(yours.features, theirs.features, score: weights.score),
                            yours: Colours.slot(yours.slot), theirs: Colours.slot(theirs.slot)),
                    playedTurns: playedTurns, optimalTurns: yours.optimal,
                    played: Notation.write(decision.playedMoves),
                    branch: Notation.write(setup + theirs.bestMoves), lookahead: lookahead))
        }
        return SolveDiff(cross: cross, pairs: pairs, learned: scorers.pair != nil, failure: nil)
    }

    /// Rank the open slots by which pair a pro would fill next, once a cross is up.
    public static func nextPairs(
        _ raw: CubeState, crossFaces: [Int] = Array(0..<6), pair: MlpWeights? = Weights.pair,
        depth: Int = 2
    ) -> NextPairs {
        let state = raw.normalized
        let setup = normalisingSetup(raw.centers.map(Int.init))
        guard let crossFace = crossFaces.first(where: { crossDistance(state, $0) == 0 }) else {
            return NextPairs(crossFace: nil, ranked: [], learned: false)
        }
        let g = geometry[crossFace]
        let open = g.slots.filter { !isSlotSolved(state, $0) }
        var options = SearchOptions()
        options.maxSolutions = Decisions.waysCap
        let usable = open.map { slot -> Ranker.PairCandidate in
            let result = enumerateF2LInsertion(state, crossFace, slot, options: options)
            return Ranker.PairCandidate(
                slot: slot, optimal: result.optimal, ways: result.candidates.count,
                bestMoves: result.candidates.first?.moves ?? [])
        }.filter { $0.optimal >= 0 }
        let predicted = pair.flatMap { weights in
            usable.isEmpty ? nil
                : Ranker.rankNextPair(
                    state, g, candidates: usable,
                    context: Ranker.PairContext(previous: nil, step: 4 - open.count), score: weights.score)
        } ?? []
        var lookaheadOptions = Lookahead.Options()
        lookaheadOptions.depth = depth
        let deeper = Lookahead.pairs(state, crossFace, options: lookaheadOptions)
        let ranked = usable.map { candidate -> RankedPair in
            let plan = deeper.options.first { $0.slot == candidate.slot }?.plan
            let forecast = plan.map { forecast($0, crossFace, depth: deeper.depth, setup: setup) }
            return RankedPair(
                slot: candidate.slot.name, label: Colours.slot(candidate.slot), optimal: candidate.optimal,
                moves: Notation.write(setup + (plan?.steps.first?.moves ?? candidate.bestMoves)),
                confidence: predicted.first { $0.slot == candidate.slot }?.confidence ?? 0,
                lookahead: forecast)
        }
        let infinity = Int.max
        return NextPairs(
            crossFace: crossFace,
            ranked: ranked.enumerated().sorted { a, b in
                let (x, y) = (a.element, b.element)
                let (tx, ty) = (x.lookahead?.totalTurns ?? infinity, y.lookahead?.totalTurns ?? infinity)
                if tx != ty { return tx < ty }
                if x.confidence != y.confidence { return x.confidence > y.confidence }
                if x.optimal != y.optimal { return x.optimal < y.optimal }
                return a.offset < b.offset
            }.map(\.element),
            learned: pair != nil)
    }
}
