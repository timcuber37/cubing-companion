import SwiftUI
import CubingCore

/// Runs the S2 sweep benchmark on an iPhone.
///
/// Exists because Xcode cannot run a Swift package's tests on a physical device: they need a host
/// app. This is the smallest one that will do — it calls `SweepBenchmark.run()`, the same code the
/// `CubingBenchmarks` test runs on a Mac, so the two numbers compare directly.
///
/// Results go to the screen and to stdout, so `xcrun devicectl device process launch --console`
/// can read them without anyone copying numbers off the phone.
@main
struct CubingBenchApp: App {
    var body: some Scene {
        WindowGroup { BenchView() }
    }
}

struct BenchView: View {
    @State private var lines: [String] = []
    @State private var running = false

    #if DEBUG
    private let configuration = "Debug — timings are meaningless, build Release"
    #else
    private let configuration = "Release"
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("S2 sweep benchmark").font(.title2.bold())
            Text(configuration).font(.footnote).foregroundStyle(.secondary)
            if running { ProgressView("Running…") }
            ForEach(lines, id: \.self) { line in
                Text(line).font(.system(.body, design: .monospaced))
            }
            Spacer()
            // No "run again": the cross tables are built by then, so a second run would report a
            // warm build as cold. Relaunch the app for another measurement.
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .task { await run() }
    }

    private func run() async {
        running = true
        // Off the main thread: the sweep takes seconds, and a frozen UI would be killed.
        let result = await Task.detached(priority: .userInitiated) { SweepBenchmark.run() }.value
        lines = result.lines
        running = false
        print("cubing-bench: \(configuration)")
        for line in result.lines { print("cubing-bench: \(line)") }
        fflush(stdout)
    }
}
