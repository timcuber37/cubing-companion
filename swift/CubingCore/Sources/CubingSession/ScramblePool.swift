/// WCA random-state scrambles, dealt from a bundled pool — S1's answer to having no two-phase
/// solver in Swift. The pool is made by `npm run scrambles`.
///
/// Dealt, not sampled: sampling ten thousand at random makes a repeat likely within about 120
/// solves, and a scramble you have seen before is recognisable. So the pool is shuffled once, with
/// a seed that is kept, and dealt in that order across launches; only when every scramble has been
/// used is it reshuffled.

import Foundation

public final class ScramblePool {
    public let scrambles: [String]
    private let defaults: UserDefaults
    private var seed: UInt64
    private var order: [Int]
    private var cursor: Int

    private static let seedKey = "scrambles.seed"
    private static let cursorKey = "scrambles.cursor"
    private static let sizeKey = "scrambles.size"

    /// Read a pool: one scramble per line.
    public convenience init(contentsOf url: URL, defaults: UserDefaults = .standard) throws {
        let text = try String(contentsOf: url, encoding: .utf8)
        self.init(scrambles: text.split(whereSeparator: \.isNewline).map(String.init), defaults: defaults)
    }

    public init(scrambles: [String], defaults: UserDefaults = .standard) {
        precondition(!scrambles.isEmpty, "an empty scramble pool")
        self.scrambles = scrambles
        self.defaults = defaults
        // A different pool — regenerated, or a new app version — starts a fresh deal.
        let stored = defaults.object(forKey: Self.seedKey) as? NSNumber
        if let stored, defaults.integer(forKey: Self.sizeKey) == scrambles.count {
            seed = stored.uint64Value
            cursor = defaults.integer(forKey: Self.cursorKey)
        } else {
            seed = UInt64.random(in: .min ... .max)
            cursor = 0
        }
        order = Self.shuffled(count: scrambles.count, seed: seed)
        save()
    }

    /// How many are left before the deal starts again.
    public var remaining: Int { scrambles.count - cursor }

    /// The next scramble, never one already dealt until every one has been.
    public func next() -> String {
        if cursor >= scrambles.count {
            seed = UInt64.random(in: .min ... .max)
            order = Self.shuffled(count: scrambles.count, seed: seed)
            cursor = 0
        }
        let scramble = scrambles[order[cursor]]
        cursor += 1
        save()
        return scramble
    }

    private func save() {
        defaults.set(NSNumber(value: seed), forKey: Self.seedKey)
        defaults.set(cursor, forKey: Self.cursorKey)
        defaults.set(scrambles.count, forKey: Self.sizeKey)
    }

    /// Fisher–Yates under SplitMix64, so a seed always means the same order.
    static func shuffled(count: Int, seed: UInt64) -> [Int] {
        var state = seed
        func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
        var order = Array(0..<count)
        for i in stride(from: count - 1, to: 0, by: -1) {
            order.swapAt(i, Int(next() % UInt64(i + 1)))
        }
        return order
    }
}
