import Dispatch
import XCTest
import CubingCore

/// P5's fixed position and options, so the Swift number is comparable to the JS baseline.
///
/// A target of its own so it can run on an iPhone, which the vector tests cannot: they read
/// `vectors/*.json` from the Mac's disk. That is also why this uses a plain `import` rather than
/// `@testable` — a Release build, the only kind whose timings mean anything, does not enable
/// testability, so nothing here may reach past the public API.
///
/// Skipped in debug builds instead of behind an environment variable: on a device there is no
/// convenient place to set one, and the build configuration is the thing that actually decides
/// whether the numbers are worth reading.
final class SweepBenchmarkTests: XCTestCase {
    private let facelets = "DRLUUBFBRBLURRLRUBLRDDFDLFUFUFFDBRDUBRUFLLFDDBFLUBLRBD"

    func testBenchmarkFullColourNeutralSweep() throws {
        #if DEBUG
        throw XCTSkip("benchmark: debug-build timings are meaningless; run with a Release build")
        #else
        let state = try Facelets.state(from: facelets)

        // Cold, one colour at a time, as P5's bench measures table build.
        let tablesStart = DispatchTime.now().uptimeNanoseconds
        _ = CrossTables.all()
        let tablesMs = Double(DispatchTime.now().uptimeNanoseconds - tablesStart) / 1e6

        let singleStart = DispatchTime.now().uptimeNanoseconds
        _ = Planner.planColour(state, 0, lookahead: true)
        let singleMs = Double(DispatchTime.now().uptimeNanoseconds - singleStart) / 1e6

        var sweeps: [Double] = []
        for _ in 0..<3 {
            let started = DispatchTime.now().uptimeNanoseconds
            for face in 0..<6 {
                _ = Planner.planColour(state, face, lookahead: true)
            }
            sweeps.append(Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6)
        }
        let median = sweeps.sorted()[1]

        var nextPairMs: Double?
        if let crossMoves = solveCross(state.normalized, 0) {
            let after = state.normalized.applying(crossMoves)
            let started = DispatchTime.now().uptimeNanoseconds
            _ = Lookahead.pairs(after, 0)
            nextPairMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
        }

        let lines = [
            "swift P5 cross tables, cold: \(Int(tablesMs)) ms",
            "swift P5 one colour: \(Int(singleMs)) ms",
            "swift P5 six-colour sweeps: \(sweeps.map { Int($0) }) ms; median \(Int(median)) ms",
            nextPairMs.map { "swift P5 next pair + lookahead: \(Int($0)) ms" },
        ].compactMap { $0 }
        for line in lines {
            print(line)
            // Also as named activities, so the numbers show in Xcode's test report — the easiest
            // place to read them after a run on a phone.
            XCTContext.runActivity(named: line) { _ in }
        }
        XCTAssertEqual(sweeps.count, 3)
        #endif
    }
}
