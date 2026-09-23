import XCTest
import CubingCore
@testable import CubingSession

final class ScramblePoolTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "scramble-pool-\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    func testDealsEveryScrambleOnceBeforeAnyRepeats() {
        let pool = ScramblePool(scrambles: (0..<50).map { "S\($0)" }, defaults: defaults())
        let dealt = (0..<50).map { _ in pool.next() }
        XCTAssertEqual(Set(dealt).count, 50)
        XCTAssertEqual(pool.remaining, 0)
        // Then a fresh deal, not an error.
        XCTAssertTrue(pool.scrambles.contains(pool.next()))
        XCTAssertEqual(pool.remaining, 49)
    }

    func testTheDealSurvivesARelaunch() {
        let store = defaults()
        let scrambles = (0..<30).map { "S\($0)" }
        let first = ScramblePool(scrambles: scrambles, defaults: store)
        let before = (0..<10).map { _ in first.next() }
        // A new instance over the same storage carries on where the last left off.
        let second = ScramblePool(scrambles: scrambles, defaults: store)
        let after = (0..<20).map { _ in second.next() }
        XCTAssertEqual(Set(before + after).count, 30)
    }

    func testAChangedPoolStartsAFreshDeal() {
        let store = defaults()
        let first = ScramblePool(scrambles: (0..<30).map { "S\($0)" }, defaults: store)
        _ = (0..<10).map { _ in first.next() }
        let regenerated = ScramblePool(scrambles: (0..<40).map { "T\($0)" }, defaults: store)
        XCTAssertEqual(regenerated.remaining, 40)
    }

    func testTheSameSeedIsTheSameOrder() {
        XCTAssertEqual(ScramblePool.shuffled(count: 100, seed: 42), ScramblePool.shuffled(count: 100, seed: 42))
        XCTAssertNotEqual(ScramblePool.shuffled(count: 100, seed: 42), ScramblePool.shuffled(count: 100, seed: 43))
        XCTAssertEqual(ScramblePool.shuffled(count: 100, seed: 7).sorted(), Array(0..<100))
    }

    /// The pool the app ships: every line a scramble the notation parser accepts, none repeated.
    func testTheBundledPoolParses() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("CubingApp/CubingApp/Resources/scrambles.txt")
        let pool = try ScramblePool(contentsOf: url, defaults: defaults())
        XCTAssertEqual(pool.scrambles.count, 10_000)
        XCTAssertEqual(Set(pool.scrambles).count, pool.scrambles.count)
        for scramble in pool.scrambles {
            let moves = try Notation.parse(scramble)
            // Random-state scrambles from cubing.js run to about twenty moves, face turns only.
            XCTAssertTrue((15...25).contains(moves.count), scramble)
            XCTAssertTrue(moves.allSatisfy { "URFDLB".contains($0.family) }, scramble)
        }
    }
}
