import CubingCore
import CubingSession
import Observation
import SwiftUI

/// A5's decision diff for one solve, computed off the main thread.
///
/// The search behind it — the cross planned with lookahead, three pair decisions each with a
/// continuation — takes a second or so on a phone, which is too long to hold up opening a solve.
@MainActor
@Observable
final class DecisionsModel {
    private(set) var diff: SolveDiff?
    private(set) var working = false
    private var task: Task<Void, Never>?

    func load(_ record: SolveRecord) {
        guard diff == nil, task == nil,
            let start = try? Facelets.state(from: record.startFacelets),
            let solution = try? Notation.parse(record.solution)
        else { return }
        working = true
        task = Task {
            let diff = await Task.detached(priority: .userInitiated) { Review.diff(start, solution) }.value
            self.diff = diff
            self.working = false
        }
    }
}

/// What a top solver would likely have done at each decision, and how your execution compared.
struct DecisionsSection: View {
    let model: DecisionsModel
    let replay: ReplayModel?

    var body: some View {
        if model.working {
            Section("Decisions") {
                HStack {
                    ProgressView()
                    Text("Comparing each decision with the model…").foregroundStyle(.secondary)
                }
            }
        } else if let diff = model.diff {
            if let failure = diff.failure {
                Section("Decisions") { Text(failure).foregroundStyle(.secondary) }
            }
            if let cross = diff.cross {
                Section("Cross") { CrossCard(cross: cross, replay: replay) }
            }
            ForEach(diff.pairs, id: \.step) { pair in
                Section("Pair \(pair.step + 1)") { PairCard(pair: pair, replay: replay, learned: diff.learned) }
            }
        }
    }
}

private struct CrossCard: View {
    let cross: CrossDiff
    let replay: ReplayModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Execution: a fact, from the search.
            HStack(alignment: .firstTextBaseline) {
                Text("\(cross.playedTurns) moves").font(.headline)
                Text(cross.playedTurns > cross.optimalTurns ? "· shortest is \(cross.optimalTurns)" : "· optimal")
                    .foregroundStyle(cross.playedTurns > cross.optimalTurns ? .orange : .green)
                Spacer()
            }
            if !cross.best.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Best: \(cross.hold)").font(.caption).foregroundStyle(.secondary)
                    Text(([cross.setup, cross.best].filter { !$0.isEmpty }).joined(separator: " · "))
                        .font(.callout.monospaced()).textSelection(.enabled)
                }
                PlayButton(title: "Play this cross", replay: replay, at: cross.at, moves: cross.branch)
            }
            if let opening = cross.lookahead {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Or plan further: \(opening.label) in \(opening.turns)").font(.caption).foregroundStyle(.secondary)
                    Text(opening.branch).font(.callout.monospaced()).textSelection(.enabled)
                }
                PlayButton(title: "Play \(opening.label)", replay: replay, at: cross.at, moves: opening.branch)
            }
        }
    }
}

private struct PairCard: View {
    let pair: PairDiff
    let replay: ReplayModel?
    let learned: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Choice: from the model, and uncertain — so a distribution, never a verdict.
            if learned {
                if pair.yours == pair.theirs {
                    Text("You took \(pair.yours) — the pair a pro \(pair.wording).")
                } else {
                    Text("You took \(pair.yours). A pro \(pair.wording) \(pair.theirs).")
                    ForEach(pair.reasons, id: \.self) { reason in
                        Label(reason, systemImage: "lightbulb").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                ConfidenceBars(options: pair.options)
            } else {
                Text("You took \(pair.yours).")
            }

            // Execution: a fact, from the search.
            HStack(alignment: .firstTextBaseline) {
                Text("\(pair.playedTurns) moves").font(.headline)
                Text(pair.playedTurns > pair.optimalTurns ? "· best insertion is \(pair.optimalTurns)" : "· optimal")
                    .foregroundStyle(pair.playedTurns > pair.optimalTurns ? .orange : .green)
            }
            Text(pair.played).font(.caption.monospaced()).foregroundStyle(.secondary)

            HStack {
                if let replay {
                    // Yours is already on the cube: jump the real solve there rather than branch.
                    Button {
                        replay.returnToSolve()
                        replay.seek(pair.at)
                        replay.play()
                    } label: {
                        Label("Play mine", systemImage: "play.circle")
                    }
                    .buttonStyle(.bordered)
                    .font(.footnote)
                }
                if pair.yours != pair.theirs || pair.playedTurns > pair.optimalTurns {
                    PlayButton(title: "Play \(pair.theirs)", replay: replay, at: pair.at, moves: pair.branch)
                }
            }
            if let lookahead = pair.lookahead {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Planning two pairs ahead: \(lookahead.forecast.totalTurns) moves, starting with \(lookahead.label)")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(lookahead.forecast.steps.enumerated()), id: \.offset) { _, step in
                        Text("\(step.label): \(step.moves)").font(.caption.monospaced())
                    }
                }
                PlayButton(title: "Play the plan", replay: replay, at: pair.at, moves: lookahead.forecast.branch)
            }
        }
    }
}

/// How the model splits its preference between the open pairs.
private struct ConfidenceBars: View {
    let options: [DiffOption]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(options, id: \.slot) { option in
                HStack(spacing: 6) {
                    Text(option.label).font(.caption).frame(width: 100, alignment: .leading)
                    GeometryReader { geometry in
                        Capsule().fill(option.mine ? Color.accentColor : .secondary.opacity(0.5))
                            .frame(width: max(3, geometry.size.width * option.confidence))
                    }
                    .frame(height: 6)
                    Text("\(Int((option.confidence * 100).rounded()))%").font(.caption2.monospacedDigit())
                        .frame(width: 34, alignment: .trailing)
                }
            }
        }
    }
}

/// Plays an alternative on the replay cube, from the decision it starts at.
private struct PlayButton: View {
    let title: String
    let replay: ReplayModel?
    let at: Int
    let moves: String

    var body: some View {
        if let replay, !moves.isEmpty {
            Button {
                replay.playBranch(at: at, moves: moves, label: title.replacingOccurrences(of: "Play ", with: ""))
            } label: {
                Label(title, systemImage: "play.circle")
            }
            .buttonStyle(.bordered)
            .font(.footnote)
        }
    }
}
