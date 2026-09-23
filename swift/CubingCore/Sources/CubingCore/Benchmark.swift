/// P5's fixed planner workload, so a Swift number is directly comparable to the TypeScript one.
///
/// Public, and in the library rather than a test target, because it has two callers that must run
/// exactly the same code: the `CubingBenchmarks` test on a Mac, and the `CubingBench` app on an
/// iPhone. Xcode cannot run a package's tests on a physical device — they need a host app — so
/// the phone measurement comes from the app.
///
/// Same position and options as `bench()` in `apps/web/workers/planner.worker.ts`: cold tables,
/// one colour, three six-colour sweeps with lookahead, and the next-pair lookahead after a cross.

import Dispatch

public enum SweepBenchmark {
    public static let facelets = "DRLUUBFBRBLURRLRUBLRDDFDLFUFUFFDBRDUBRUFLLFDDBFLUBLRBD"

    public struct Result: Sendable {
        /// Only cold if nothing in this process has built a cross table yet.
        public let tablesMs: Double
        public let oneColourMs: Double
        public let sweepsMs: [Double]
        public let nextPairMs: Double?

        public var medianSweepMs: Double { sweepsMs.sorted()[sweepsMs.count / 2] }

        public var lines: [String] {
            [
                "cross tables, cold: \(Int(tablesMs)) ms",
                "one colour: \(Int(oneColourMs)) ms",
                "six-colour sweeps: \(sweepsMs.map { Int($0) }) ms",
                "median sweep: \(Int(medianSweepMs)) ms",
                nextPairMs.map { "next pair + lookahead: \(Int($0)) ms" },
            ].compactMap { $0 }
        }
    }

    public static func run(sweeps: Int = 3) -> Result {
        let state = try! Facelets.state(from: facelets)

        func time(_ body: () -> Void) -> Double {
            let started = DispatchTime.now().uptimeNanoseconds
            body()
            return Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
        }

        let tablesMs = time { _ = CrossTables.all() }
        let oneColourMs = time { _ = Planner.planColour(state, 0, lookahead: true) }
        let sweepsMs = (0..<sweeps).map { _ in
            time { for face in 0..<6 { _ = Planner.planColour(state, face, lookahead: true) } }
        }

        // Pair ranking only means anything once a cross is built, so build one outside the timing.
        var nextPairMs: Double?
        if let cross = solveCross(state.normalized, 0) {
            let after = state.normalized.applying(cross)
            nextPairMs = time { _ = Lookahead.pairs(after, 0) }
        }

        return Result(
            tablesMs: tablesMs, oneColourMs: oneColourMs, sweepsMs: sweepsMs,
            nextPairMs: nextPairMs)
    }
}
