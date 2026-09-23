import CubeLink
import CubingCore
import SwiftUI

/// S3's one screen: connect a cube and watch it mirrored.
///
/// Deliberately not the app's eventual information architecture — that is S4 and S5. This is the
/// A1 milestone, natively: the cube in your hand and the cube on the screen agree, move for move.
struct ContentView: View {
    @State private var model = CubeModel()
    @State private var scanning = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                status
                CubeSceneView(facelets: model.facelets, lastMove: model.lastMove, revision: model.revision)
                    .frame(height: 320)
                    .accessibilityLabel("The mirrored cube")
                actions
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                List {
                    if model.isConnected || model.recording != nil {
                        linkSection
                    }
                    if let desync = model.lastDesync {
                        Section("Resynchronised \(model.desyncs)×") {
                            Text(desync).font(.footnote.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                    Section("Moves") {
                        if model.moves.isEmpty {
                            Text(model.isConnected ? "Turn the cube." : "No cube connected.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(model.moves) { move in
                            HStack {
                                Text(move.notation).font(.body.monospaced().bold()).frame(width: 36, alignment: .leading)
                                Text("#\(move.serial)").foregroundStyle(.secondary).font(.footnote.monospaced())
                                Spacer()
                                if let gap = move.gapMs { Text("+\(Int(gap.rounded())) ms").font(.footnote.monospaced()) }
                                moveTag(move).frame(width: 84, alignment: .trailing)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Cubing Native")
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $scanning, onDismiss: model.stopScan) {
            ScanSheet(model: model, isPresented: $scanning)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.resumed() }
        }
        .onChange(of: model.isConnected) { _, connected in
            if connected { scanning = false }
        }
    }

    /// Where a move's time went: recovered from history, held waiting for one that was, or neither.
    @ViewBuilder
    private func moveTag(_ move: CubeModel.LoggedMove) -> some View {
        if move.recovered {
            Text("recovered").font(.caption2.bold()).foregroundStyle(.orange)
        } else if let held = move.heldMs, held >= 40 {
            Text("held \(Int(held)) ms").font(.caption2.bold()).foregroundStyle(.orange)
        } else {
            Text(move.source.rawValue).font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// The move buffer's cost, and a way to capture a session for replay on the Mac.
    private var linkSection: some View {
        Section("Link") {
            LabeledContent("History asked / answered", value: "\(model.stats.historyRequests) / \(model.stats.historyResponses)")
            if let median = model.stats.medianAnswerMs {
                LabeledContent("Median answer", value: "\(Int(median)) ms")
            }
            LabeledContent("Recovered moves", value: "\(model.recoveredMoves)")
            LabeledContent("Longest hold", value: "\(Int(model.longestHoldMs)) ms")
            if model.isConnected {
                Button(model.isRecording ? "Stop recording" : "Record frames", systemImage: model.isRecording ? "stop.circle" : "record.circle") {
                    model.toggleRecording()
                }
                .foregroundStyle(model.isRecording ? .red : .accentColor)
            }
            if let recording = model.recording, !model.isRecording {
                ShareLink(item: recording) { Label("Share recording", systemImage: "square.and.arrow.up") }
            }
        }
        .font(.footnote)
    }

    private var status: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColour).frame(width: 8, height: 8)
            Text(statusText).font(.subheadline).lineLimit(2)
            Spacer()
            if let battery = model.battery {
                Label("\(battery)%", systemImage: batterySymbol(battery)).font(.footnote.monospacedDigit())
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var actions: some View {
        HStack {
            if model.isConnected {
                Button("Sync", systemImage: "arrow.triangle.2.circlepath", action: model.sync)
                Button("Solved", systemImage: "checkmark.seal", action: model.markSolved)
                Spacer()
                Button("Disconnect", role: .destructive, action: model.disconnect)
            } else {
                Button("Connect a cube", systemImage: "dot.radiowaves.left.and.right") {
                    model.scan()
                    scanning = true
                }
                .buttonStyle(.borderedProminent)
                if model.hasRememberedCube {
                    Button("Reconnect", action: model.reconnect)
                }
                Spacer()
            }
        }
        .buttonStyle(.bordered)
    }

    private var statusText: String {
        switch model.link {
        case .idle: "Not connected"
        case .unavailable(let reason): reason
        case .scanning: "Looking for cubes…"
        case .connecting(let name): "Connecting to \(name)…"
        case .connected(let name, let proto):
            [name, model.hardware.map { "v\($0.softwareVersion)" }, proto.rawValue.capitalized,
             model.skewPercent.map { String(format: "clock %+.2f%%", $0) }]
                .compactMap { $0 }.joined(separator: " · ")
        case .failed(let reason): reason
        }
    }

    private var statusColour: Color {
        switch model.link {
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
}

private struct ScanSheet: View {
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
