import CubingCore
import CubingSession
import SwiftData
import SwiftUI

/// Every solve, by session: the averages a cuber watches, and each solve opened up.
struct HistoryScreen: View {
    let solves: SolveModel
    @Query(sort: \StoredSession.startedAt, order: .reverse) private var sessions: [StoredSession]
    /// The session being looked at; nil means the one being recorded into. Debug builds take
    /// `-viewSession <id>` for screenshots.
    @State private var viewing: String? = {
        #if DEBUG
        UserDefaults.standard.string(forKey: "viewSession")
        #else
        nil
        #endif
    }()

    private var sessionId: String { viewing ?? solves.sessionId }

    var body: some View {
        NavigationStack {
            SessionSolves(sessionId: sessionId, solves: solves)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Session", selection: Binding(get: { sessionId }, set: { viewing = $0 })) {
                                ForEach(sessions) { session in
                                    Text(session.id == solves.sessionId ? "\(session.label) (current)" : session.label)
                                        .tag(session.id)
                                }
                            }
                            Divider()
                            Button("New session", systemImage: "plus") {
                                solves.startNewSession()
                                viewing = nil
                            }
                        } label: {
                            Image(systemName: "rectangle.stack")
                        }
                    }
                }
        }
    }

    private var title: String {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return "History" }
        return session.id == solves.sessionId ? "This session" : session.label
    }
}

/// One session's solves, newest first, with its statistics on top.
private struct SessionSolves: View {
    let solves: SolveModel
    @Query private var stored: [StoredSolve]

    init(sessionId: String, solves: SolveModel) {
        self.solves = solves
        _stored = Query(
            filter: #Predicate<StoredSolve> { $0.sessionId == sessionId },
            sort: \StoredSolve.startedAt, order: .reverse)
    }

    /// Debug builds only: `-openSolve <id>` opens that solve, so a simulator screenshot can show the
    /// detail screen without anyone tapping.
    @State private var opened: String?

    var body: some View {
        let records = stored.map(\.record)
        List {
            Section { StatsCard(stats: Stats.session(records)) }
            Section("\(records.count) solves") {
                if records.isEmpty {
                    Text("No solves yet. Connect a cube and solve the scramble on the Solve tab.")
                        .foregroundStyle(.secondary)
                }
                ForEach(records) { record in
                    NavigationLink {
                        SolveDetail(finished: solves.analyse(record))
                    } label: {
                        SolveRow(record: record)
                    }
                }
                .onDelete { offsets in
                    for i in offsets { solves.delete(records[i].id) }
                }
            }
        }
        .navigationDestination(item: $opened) { id in
            if let record = records.first(where: { $0.id == id }) { SolveDetail(finished: solves.analyse(record)) }
        }
        .onAppear {
            #if DEBUG
            if opened == nil, let id = UserDefaults.standard.string(forKey: "openSolve") { opened = id }
            #endif
        }
    }
}

/// Best, mean, and the trimmed averages of five and twelve, current and best.
private struct StatsCard: View {
    let stats: SessionStats

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
            GridRow {
                stat("Best", stats.best)
                stat("Mean", stats.mean)
                stat("Solves", nil, text: "\(stats.count)")
            }
            GridRow {
                stat("ao5", stats.averages[5]?.current)
                stat("Best ao5", stats.averages[5]?.best)
                stat("", nil, text: "")
            }
            GridRow {
                stat("ao12", stats.averages[12]?.current)
                stat("Best ao12", stats.averages[12]?.best)
                stat("", nil, text: "")
            }
        }
    }

    private func stat(_ label: String, _ ms: Double?, text: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(text ?? Format.time(ms)).font(.headline.monospacedDigit())
        }
    }
}

private struct SolveRow: View {
    let record: SolveRecord

    var body: some View {
        HStack {
            Text(record.outcome == .discarded ? "DNF" : Format.time(record.durationMs))
                .font(.body.monospacedDigit().bold())
                .foregroundStyle(record.outcome == .discarded ? .secondary : .primary)
                .frame(width: 80, alignment: .leading)
            VStack(alignment: .leading) {
                Text("\(record.moveCount) moves · \(Format.tps(record.tps)) TPS").font(.footnote.monospacedDigit())
                Text(Format.date(record.startedAt)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if !record.scrambleMatched {
                // Solved from wherever the cube was, not from a scramble.
                Image(systemName: "hand.point.up.left").foregroundStyle(.secondary)
                    .accessibilityLabel("Started from the cube's own position")
            }
        }
    }
}

/// One solve opened up: its scramble, its phases with the moves of each, and how it rated.
struct SolveDetail: View {
    let finished: SolveModel.Finished
    @State private var replay: ReplayModel?
    @State private var decisions = DecisionsModel()

    var body: some View {
        let record = finished.record
        List {
            if let replay {
                Section { ReplayView(model: replay) }
            }
            Section { SolveSummary(finished: finished) }
            if let scramble = record.scrambleText {
                Section("Scramble") { Text(scramble).font(.callout.monospaced()).textSelection(.enabled) }
            }
            if let spans = finished.segmented?.segmentation.segmentation?.spans {
                Section("Reconstruction") {
                    ForEach(Array(spans.enumerated()), id: \.offset) { _, span in
                        if !span.moves.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Format.phase(span.phase) + (span.slot.map { " · \($0)" } ?? ""))
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(Notation.write(span.moves)).font(.callout.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                }
            } else {
                Section("Solution") { Text(record.solution).font(.callout.monospaced()).textSelection(.enabled) }
            }
            DecisionsSection(model: decisions, replay: replay)
            if let score = finished.score {
                Section("Rating") {
                    if let rating = score.rating {
                        LabeledContent("Overall", value: Format.rating(rating))
                    }
                    ForEach(score.components, id: \.label) { component in
                        LabeledContent(component.label, value: Format.rating(component.rated.rating))
                    }
                    ForEach(score.omitted, id: \.label) { omitted in
                        VStack(alignment: .leading) {
                            Text(omitted.label).foregroundStyle(.secondary)
                            Text(omitted.reason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let band = score.fluidityBand, let fluidity = score.fluidity {
                        LabeledContent("Flow", value: "\(band) · \(Int((fluidity * 100).rounded()))%")
                    }
                }
            }
        }
        .navigationTitle(Format.date(record.startedAt))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if replay == nil { replay = ReplayModel(record) }
            decisions.load(record)
        }
        .onDisappear { replay?.pause() }
    }
}
