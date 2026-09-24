import CubingCore
import CubingSession
import Observation
import SwiftUI

/// Planning the start of a solve: crosses, x-crosses and openings for the scramble, and which pair
/// to do next once a cross is up.
///
/// The web app's `PlannerPanel`, with one change a phone makes possible. The web plans once the
/// cube matches the scramble; here the scramble's position is known the moment it is armed, so
/// planning starts then and the answer is usually ready before the scramble is turned in.
@MainActor
@Observable
final class PlanModel {
    /// One colour's plan, the crosses re-ranked by the model where it loads.
    struct ColourResult: Identifiable {
        var id: Int { plan.crossFace }
        let plan: ColourPlan
        let cross: [PlannedSolution]
    }

    /// Which cross colours to plan for, remembered. White alone by default, as in the web app: a
    /// colour-neutral sweep is six times the work, and most people build one colour.
    var colours: Set<Int> {
        didSet {
            UserDefaults.standard.set(Array(colours), forKey: Self.coloursKey)
            if let target { plan(for: target) }
        }
    }

    /// Practice: the real 15-second inspection, with the answer hidden until it is over.
    var practice: Bool {
        didSet { UserDefaults.standard.set(practice, forKey: Self.practiceKey) }
    }

    private(set) var results: [ColourResult] = []
    private(set) var planning = false
    private(set) var inspectionStarted: Date?
    private(set) var revealed = false

    private(set) var nextPairs: NextPairs?
    private(set) var rankingPairs = false

    private var target: CubeState?
    private var task: Task<Void, Never>?

    static let inspectionSeconds = 15.0
    private static let coloursKey = "plan.colours"
    private static let practiceKey = "plan.practice"

    init() {
        let stored = UserDefaults.standard.array(forKey: Self.coloursKey) as? [Int]
        colours = Set(stored?.filter { (0..<6).contains($0) } ?? []).isEmpty ? [0] : Set(stored!)
        practice = UserDefaults.standard.bool(forKey: Self.practiceKey)
    }

    /// Whether the plans may be shown yet.
    var visible: Bool { !practice || revealed }

    /// Plan for a position, abandoning whatever was being planned before.
    func plan(for state: CubeState) {
        task?.cancel()
        target = state
        results = []
        revealed = false
        inspectionStarted = nil
        planning = true
        let faces = Array(colours).sorted()
        task = Task { [weak self] in
            for face in faces {
                let result = await Task.detached(priority: .userInitiated) { () -> ColourResult in
                    let plan = Planner.planColour(state, face, keep: 3, lookahead: true)
                    let cross = Weights.cross.map {
                        Ranker.rerankCross(plan.cross, startCentres: state.centers, score: $0.score)
                    } ?? plan.cross
                    return ColourResult(plan: plan, cross: cross)
                }.value
                guard let self, !Task.isCancelled else { return }
                results.append(result)
                // Shortest cross first, as the web app sorts its colours.
                results.sort { $0.plan.crossLength < $1.plan.crossLength }
            }
            self?.planning = false
        }
    }

    /// The cube matches the scramble: inspection starts now.
    func inspectionBegan() {
        if inspectionStarted == nil { inspectionStarted = Date() }
    }

    func reveal() { revealed = true }

    /// Which pair next, for the cube as it stands.
    func rankPairs(_ state: CubeState) {
        rankingPairs = true
        nextPairs = nil
        Task {
            let ranked = await Task.detached(priority: .userInitiated) { Review.nextPairs(state) }.value
            nextPairs = ranked
            rankingPairs = false
        }
    }
}

/// The planner, as a sheet over the Solve tab.
struct PlanSheet: View {
    let plan: PlanModel
    let cube: CubeModel
    @State private var mode = Mode.cross

    enum Mode: String, CaseIterable { case cross = "Cross", pair = "Which pair" }

    var body: some View {
        NavigationStack {
            List {
                Picker("Mode", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                switch mode {
                case .cross: crossPlans
                case .pair: pairRanking
                }
            }
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: Cross

    @ViewBuilder
    private var crossPlans: some View {
        Section {
            ColourPicker(selection: Binding(get: { plan.colours }, set: { plan.colours = $0 }))
            Toggle("Practice inspection", isOn: Binding(get: { plan.practice }, set: { plan.practice = $0 }))
        } footer: {
            Text(plan.practice
                ? "The plans stay hidden for the 15 seconds of WCA inspection, starting when the cube matches the scramble."
                : "Planned from the scramble as soon as it appears, for the colours chosen.")
        }

        if !plan.visible {
            Section {
                if let started = plan.inspectionStarted {
                    TimelineView(.periodic(from: .now, by: 0.1)) { context in
                        let left = PlanModel.inspectionSeconds - context.date.timeIntervalSince(started)
                        if left > 0 {
                            Text("Inspecting: \(Int(left.rounded(.up)))")
                                .font(.title.monospacedDigit())
                        } else {
                            Button("Time's up — show the plan", action: plan.reveal).font(.headline)
                        }
                    }
                } else {
                    Text("Turn in the scramble; inspection starts when it matches.").foregroundStyle(.secondary)
                }
                Button("Reveal now", action: plan.reveal)
            }
        } else {
            if plan.results.isEmpty, plan.planning {
                Section { HStack { ProgressView(); Text("Searching…").foregroundStyle(.secondary) } }
            }
            ForEach(plan.results) { result in
                ColourPlanSection(result: result)
            }
            if plan.planning, !plan.results.isEmpty {
                Section { HStack { ProgressView(); Text("Still searching the other colours…").foregroundStyle(.secondary) } }
            }
        }
    }

    // MARK: Which pair

    @ViewBuilder
    private var pairRanking: some View {
        Section {
            Button("Rank the pairs for the cube as it is", systemImage: "list.number") {
                plan.rankPairs(cube.trackedState)
            }
            .disabled(!cube.isConnected || plan.rankingPairs)
        } footer: {
            Text("Build a cross, then ask. Ranked by moves through the next two pairs, with the model's preference breaking ties.")
        }
        if plan.rankingPairs {
            Section { HStack { ProgressView(); Text("Searching ahead…").foregroundStyle(.secondary) } }
        } else if let next = plan.nextPairs {
            if next.crossFace == nil {
                Section { Text("No cross is built yet.").foregroundStyle(.secondary) }
            } else if next.ranked.isEmpty {
                Section { Text("Every pair is already in.").foregroundStyle(.secondary) }
            }
            ForEach(Array(next.ranked.enumerated()), id: \.offset) { i, pair in
                Section(i == 0 ? "Best next" : "Option \(i + 1)") {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(pair.label).font(.headline)
                            Spacer()
                            if next.learned {
                                Text("\(Int((pair.confidence * 100).rounded()))%").font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(pair.moves).font(.callout.monospaced()).textSelection(.enabled)
                        if let lookahead = pair.lookahead {
                            Text("\(lookahead.immediateTurns) now · \(lookahead.totalTurns) through \(lookahead.depth) pair\(lookahead.depth == 1 ? "" : "s")")
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(Array(lookahead.steps.enumerated().dropFirst()), id: \.offset) { _, step in
                                Text("then \(step.label): \(step.moves)").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            if lookahead.immediateTurns > pair.optimal {
                                Text("Uses \(lookahead.immediateTurns - pair.optimal) extra move\(lookahead.immediateTurns - pair.optimal == 1 ? "" : "s") on this pair to set up the next.")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        } else {
                            Text("\(pair.optimal) moves · no continuation found").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }
}

/// Six colour chips; at least one stays selected.
private struct ColourPicker: View {
    @Binding var selection: Set<Int>

    var body: some View {
        HStack {
            ForEach(0..<6, id: \.self) { face in
                let on = selection.contains(face)
                Button {
                    if on, selection.count > 1 { selection.remove(face) } else { selection.insert(face) }
                } label: {
                    Circle()
                        .fill(Color(hex: Colours.hex[face]))
                        .overlay(Circle().stroke(on ? Color.accentColor : .secondary.opacity(0.4), lineWidth: on ? 3 : 1))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(Colours.name(face)) cross\(on ? ", selected" : "")")
                if face < 5 { Spacer() }
            }
        }
    }
}

/// One colour's options: the crosses, the best x-cross, and openings through one or two pairs.
private struct ColourPlanSection: View {
    let result: PlanModel.ColourResult

    var body: some View {
        Section("\(Colours.name(result.plan.crossFace).capitalized) cross · \(result.plan.crossLength) moves") {
            ForEach(Array(result.cross.enumerated()), id: \.offset) { _, solution in
                SolutionRow(solution: solution)
            }
            if let xcross = result.plan.xcross.first {
                SolutionRow(solution: xcross, title: "X-cross\(xcross.slotLabel.map { " · \($0)" } ?? "")")
            }
            if let opening = result.plan.crossPlusOne?.first {
                SolutionRow(solution: opening, title: "Cross + 1")
            }
            if let opening = result.plan.crossPlusTwo?.first {
                SolutionRow(solution: opening, title: "Cross + 2")
            }
        }
    }
}

private struct SolutionRow: View {
    let solution: PlannedSolution
    var title: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                if let title { Text(title).font(.caption.bold()) }
                Text("\(solution.length) moves").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(Colours.name(solution.hold.down)) down, \(Colours.name(solution.hold.front)) front")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !solution.setup.isEmpty {
                Text("Hold: \(Notation.write(solution.setup))").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if let steps = solution.steps, steps.count > 1 {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    Text("\(step.label): \(step.text)").font(.callout.monospaced())
                }
            } else {
                Text(solution.text).font(.callout.monospaced()).textSelection(.enabled)
            }
        }
    }
}

extension Color {
    /// `#rrggbb`, as the shared palette in `Colours` is written.
    init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255)
    }
}
