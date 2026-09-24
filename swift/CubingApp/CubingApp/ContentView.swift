import CubeLink
import CubingCore
import CubingSession
import SwiftUI

/// The app's two tabs: solving, and what has been solved.
struct RootView: View {
    let cube: CubeModel
    let solves: SolveModel
    let plan: PlanModel

    @State private var tab = RootView.initialTab

    var body: some View {
        // `.tabItem` rather than `Tab`, which needs iOS 18; the app targets 17.
        TabView(selection: $tab) {
            SolveScreen(cube: cube, solves: solves, plan: plan)
                .tabItem { Label("Solve", systemImage: "cube") }
                .tag("solve")
            HistoryScreen(solves: solves)
                .tabItem { Label("History", systemImage: "list.bullet.rectangle") }
                .tag("history")
        }
    }

    /// Debug builds only: `-initialTab history` opens on History, so a simulator screenshot can show
    /// it without anyone tapping.
    private static var initialTab: String {
        #if DEBUG
        UserDefaults.standard.string(forKey: "initialTab") ?? "solve"
        #else
        "solve"
        #endif
    }
}

/// Connect, scramble, solve — with the mirrored cube, the timer, and the last solve's result.
struct SolveScreen: View {
    let cube: CubeModel
    let solves: SolveModel
    let plan: PlanModel
    @State private var scanning = false
    @State private var planning = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                status
                CubeSceneView(facelets: cube.facelets, lastMove: cube.lastMove, revision: cube.revision)
                    .frame(height: 250)
                    .accessibilityLabel("The mirrored cube")
                attempt
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                List {
                    if let summary = solves.importSummary {
                        Section {
                            Text("Brought in \(summary.added) solves from the previous app.")
                        }
                    }
                    if let error = solves.error {
                        Section { Text(error).foregroundStyle(.red) }
                    }
                    if let last = solves.lastSolve {
                        Section("Last solve") {
                            SolveSummary(finished: last)
                            NavigationLink("Review this solve") { SolveDetail(finished: last) }
                        }
                    }
                    Section {
                        DisclosureGroup("Link diagnostics") { LinkDiagnostics(cube: cube) }
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Cubing Native")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if cube.isConnected {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("Sync with the cube", systemImage: "arrow.triangle.2.circlepath", action: cube.sync)
                            Button("Cube is solved", systemImage: "checkmark.seal", action: cube.markSolved)
                            Button("Disconnect", systemImage: "xmark.circle", role: .destructive, action: cube.disconnect)
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $scanning, onDismiss: cube.stopScan) {
            ScanSheet(model: cube, isPresented: $scanning)
        }
        .sheet(isPresented: $planning) { PlanSheet(plan: plan, cube: cube) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { cube.resumed() }
        }
        .onChange(of: cube.isConnected) { _, connected in
            if connected { scanning = false }
        }
    }

    // MARK: Status

    private var status: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColour).frame(width: 8, height: 8)
            Text(statusText).font(.subheadline).lineLimit(2)
            Spacer()
            if let battery = cube.battery {
                Label("\(battery)%", systemImage: batterySymbol(battery)).font(.footnote.monospacedDigit())
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var statusText: String {
        switch cube.link {
        case .idle: "Not connected"
        case .unavailable(let reason): reason
        case .scanning: "Looking for cubes…"
        case .connecting(let name): "Connecting to \(name)…"
        case .connected(let name, _):
            [name, cube.hardware.map { "v\($0.softwareVersion)" }].compactMap { $0 }.joined(separator: " · ")
        case .failed(let reason): reason
        }
    }

    private var statusColour: Color {
        switch cube.link {
        case .connected: .green
        case .connecting, .scanning: .orange
        case .failed, .unavailable: .red
        case .idle: .secondary
        }
    }

    private func batterySymbol(_ level: Int) -> String {
        switch level {
        case ..<13: "battery.0"
        case ..<38: "battery.25"
        case ..<63: "battery.50"
        case ..<88: "battery.75"
        default: "battery.100"
        }
    }

    // MARK: The attempt

    /// One panel whose content follows the recorder: connect, scramble, inspect, solve.
    @ViewBuilder
    private var attempt: some View {
        if !cube.isConnected {
            HStack {
                Button("Connect a cube", systemImage: "dot.radiowaves.left.and.right") {
                    cube.scan()
                    scanning = true
                }
                .buttonStyle(.borderedProminent)
                if cube.hasRememberedCube {
                    Button("Reconnect", action: cube.reconnect).buttonStyle(.bordered)
                }
                Spacer()
            }
            .padding(.top, 8)
        } else {
            switch solves.phase {
            case .scrambling:
                VStack(alignment: .leading, spacing: 8) {
                    ScrambleText(moves: solves.scramble, progress: solves.progress)
                    if solves.progress == .offTrack {
                        Text("Off track: undo your last turns, or start from here.")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                    HStack {
                        Button("Plan", systemImage: "lightbulb") { planning = true }
                        Button("New scramble", systemImage: "shuffle", action: solves.newScramble)
                        Button("Start from here", action: solves.startFromHere)
                    }
                    .buttonStyle(.bordered)
                    .font(.footnote)
                }
                .padding(.top, 8)
            case .ready:
                VStack(spacing: 4) {
                    Text(Format.time(0)).font(.system(size: 56, weight: .semibold, design: .rounded).monospacedDigit())
                    Text("Scrambled. Inspect, then turn to start.").font(.footnote).foregroundStyle(.secondary)
                    Button("Plan", systemImage: "lightbulb") { planning = true }
                        .buttonStyle(.bordered).font(.footnote)
                }
                .frame(maxWidth: .infinity)
            case .solving:
                VStack(spacing: 4) {
                    TimelineView(.animation(minimumInterval: 0.03)) { context in
                        Text(Format.time(solves.solveStartedAt.map { context.date.timeIntervalSince($0) * 1000 }))
                            .font(.system(size: 56, weight: .semibold, design: .rounded).monospacedDigit())
                    }
                    HStack {
                        Text("\(solves.moveCount) moves").font(.footnote).foregroundStyle(.secondary)
                        Spacer()
                        Button("Discard", role: .destructive, action: solves.discard).font(.footnote)
                    }
                }
                .frame(maxWidth: .infinity)
            case .idle, .complete:
                ProgressView().frame(maxWidth: .infinity).padding(.top, 8)
            }
        }
    }
}

/// The scramble, with the moves already turned greyed and the next one picked out.
struct ScrambleText: View {
    let moves: [Move]
    let progress: SolveModel.ScrambleProgress

    var body: some View {
        Text(attributed)
            .font(.title3.monospaced())
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Scramble: \(moves.map(\.notation).joined(separator: " "))")
    }

    private var attributed: AttributedString {
        let done: Int
        let half: Bool
        switch progress {
        case .onTrack(let d, let h): (done, half) = (d, h)
        case .offTrack: (done, half) = (-1, false)
        }
        var text = AttributedString()
        for (i, move) in moves.enumerated() {
            var run = AttributedString(move.notation + (i < moves.count - 1 ? "  " : ""))
            if done < 0 {
                run.foregroundColor = .orange
            } else if i < done {
                run.foregroundColor = .secondary
            } else if i == done {
                run.foregroundColor = .accentColor
                run.font = .title3.monospaced().bold()
                // Underlined when a half turn is half done: a smart cube reports R2 as two turns.
                if half { run.underlineStyle = .single }
            }
            text += run
        }
        return text
    }
}

/// A finished solve at a glance: the time, the rate, the phases, and how it rated.
struct SolveSummary: View {
    let finished: SolveModel.Finished

    var body: some View {
        let record = finished.record
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(record.outcome == .discarded ? "Discarded" : Format.time(record.durationMs))
                    .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(record.outcome == .discarded ? .secondary : .primary)
                Spacer()
                VStack(alignment: .trailing) {
                    Text("\(record.moveCount) moves")
                    Text("\(Format.tps(record.tps)) TPS")
                }
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            if let segmented = finished.segmented {
                PhaseTable(segmented: segmented)
            }
            if let score = finished.score, !score.components.isEmpty {
                ScoreRow(score: score)
            }
        }
    }
}

/// Phase by phase: turns and time, from the fitted timeline.
struct PhaseTable: View {
    let segmented: SegmentedSolve

    /// A pair named by its colours: slot names like "UR" are positions in the search frame, and
    /// mean nothing to someone holding the cube after a rotation.
    private func pairLabel(_ slot: String?) -> String {
        guard let slot, let crossFace = segmented.segmentation.segmentation?.crossFace,
            let match = geometry[crossFace].slots.first(where: { $0.name == slot })
        else { return "" }
        return Colours.slot(match)
    }

    var body: some View {
        if let spans = segmented.segmentation.segmentation?.spans {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                ForEach(Array(spans.enumerated()), id: \.offset) { i, span in
                    GridRow {
                        Text(Format.phase(span.phase)).font(.footnote)
                        Text(pairLabel(span.slot)).font(.caption).foregroundStyle(.secondary)
                        Text("\(span.turns)").font(.footnote.monospacedDigit()).gridColumnAlignment(.trailing)
                        Text(Format.time(segmented.phaseDurations[i])).font(.footnote.monospacedDigit())
                            .gridColumnAlignment(.trailing)
                    }
                    .foregroundStyle(span.turns == 0 ? .secondary : .primary)
                }
            }
        } else if let failure = segmented.segmentation.failure {
            Text("Not segmented: \(failure.rawValue)").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Ratings out of ten against the corpus of pro solves — and, for speed, against your own.
struct ScoreRow: View {
    let score: SolveScore

    var body: some View {
        HStack {
            ForEach(score.components, id: \.label) { component in
                VStack {
                    Text(Format.rating(component.rated.rating)).font(.headline.monospacedDigit())
                    Text(component.label).font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// S3's diagnostics, now out of the way: link statistics, frame recording, the raw move log.
struct LinkDiagnostics: View {
    let cube: CubeModel

    var body: some View {
        Group {
            LabeledContent("History asked / answered", value: "\(cube.stats.historyRequests) / \(cube.stats.historyResponses)")
            if let median = cube.stats.medianAnswerMs {
                LabeledContent("Median answer", value: "\(Int(median)) ms")
            }
            LabeledContent("Recovered moves", value: "\(cube.recoveredMoves)")
            LabeledContent("Longest hold", value: "\(Int(cube.longestHoldMs)) ms")
            if let skew = cube.skewPercent {
                LabeledContent("Cube clock", value: String(format: "%+.2f%%", skew))
            }
            if cube.isConnected {
                Button(cube.isRecording ? "Stop recording" : "Record frames",
                       systemImage: cube.isRecording ? "stop.circle" : "record.circle", action: cube.toggleRecording)
                    .foregroundStyle(cube.isRecording ? .red : .accentColor)
            }
            if let recording = cube.recording, !cube.isRecording {
                ShareLink(item: recording) { Label("Share recording", systemImage: "square.and.arrow.up") }
            }
            ForEach(cube.moves.prefix(12)) { move in
                HStack {
                    Text(move.notation).font(.body.monospaced().bold())
                    Text("#\(move.serial)").foregroundStyle(.secondary).font(.footnote.monospaced())
                    Spacer()
                    if move.recovered {
                        Text("recovered").font(.caption2.bold()).foregroundStyle(.orange)
                    } else if let held = move.heldMs, held >= 40 {
                        Text("held \(Int(held)) ms").font(.caption2.bold()).foregroundStyle(.orange)
                    } else {
                        Text(move.source.rawValue).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .font(.footnote)
    }
}

struct ScanSheet: View {
    let model: CubeModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.discovered.isEmpty {
                        HStack {
                            ProgressView()
                            Text("Turn a face to wake the cube.").foregroundStyle(.secondary)
                        }
                    }
                    ForEach(model.discovered) { cube in
                        Button {
                            model.connect(cube)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(cube.name)
                                    // Without the address there is no key; say so rather than fail later.
                                    Text(cube.mac ?? "waiting for its address…")
                                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(cube.rssi) dBm").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(!model.knowsAddress(of: cube))
                    }
                } footer: {
                    if case .failed(let reason) = model.link { Text(reason).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Nearby cubes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { isPresented = false } }
            }
        }
        .presentationDetents([.medium])
    }
}
