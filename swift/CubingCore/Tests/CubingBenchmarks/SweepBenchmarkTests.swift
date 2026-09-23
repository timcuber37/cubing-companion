import XCTest
import CubingCore

/// The S2 sweep benchmark on a Mac: `npm run swift-bench`.
///
/// For the phone, run the `CubingBench` app in `swift/CubingBench` instead — Xcode cannot run a
/// package's tests on a physical device. Both call `SweepBenchmark.run()`, so the numbers compare.
///
/// A target of its own, with a plain `import`, so it builds in Release without testability; and
/// skipped in debug builds, whose timings mean nothing.
final class SweepBenchmarkTests: XCTestCase {
    func testBenchmarkFullColourNeutralSweep() throws {
        #if DEBUG
        throw XCTSkip("benchmark: debug-build timings are meaningless; run with a Release build")
        #else
        let result = SweepBenchmark.run()
        for line in result.lines {
            print("swift P5 \(line)")
            // Also as named activities, so the numbers show in Xcode's test report.
            XCTContext.runActivity(named: line) { _ in }
        }
        XCTAssertEqual(result.sweepsMs.count, 3)
        #endif
    }
}
