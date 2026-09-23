/// Parsing and writing move notation.
///
/// The TypeScript delegates parsing to cubing.js, which buys the whole alg.cubing.net dialect for
/// free — commutators, conjugates, groupings — and is the right trade there because the
/// reconstruction corpus is written in it. Swift has no such library, so this is a hand-written
/// parser over the subset the app actually produces and consumes: face turns, wide moves, slices
/// and rotations, with `'` and `2` modifiers, lowercase aliases, and `//` comments.
///
/// What it deliberately does **not** accept is layer-prefixed notation (`2U`, `3Rw`, `2-3r`). The
/// TypeScript rejects those too, and for a reason worth preserving: `2U` is not `u`, the tables do
/// not model it, and accepting it blindly would silently apply `U` instead. Big-cube notation is
/// absent from CFOP reconstructions; rejecting is better than guessing.
///
/// Commutator and conjugate syntax is out of scope here. If the corpus is ever fed to the Swift
/// port directly it will need them, but nothing the app itself writes uses them.

public struct NotationError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

public enum Notation {
    /// Parse an algorithm into a flat move list.
    ///
    /// Comments and no-op moves such as `R4` are dropped; an unknown family or a layer prefix
    /// throws, so a typo fails loudly rather than being applied as something else.
    public static func parse(_ text: String) throws -> [Move] {
        var moves: [Move] = []

        for var token in tokens(of: text) {
            // Layer prefixes: a leading digit, or a range like `2-3`.
            if let first = token.first, first.isNumber || first == "-" {
                throw NotationError("layer-prefixed moves are not supported: \(token)")
            }

            // `<family><digits?><'?>`. The count is parsed as a number rather than matched
            // against "2", so `R4` reads as a whole rotation — a legitimate no-op that appears in
            // reconstructions — instead of failing as an unknown family called "R4".
            var inverted = false
            while let last = token.last, last == "'" || last == "\u{2019}" {
                inverted = true
                token.removeLast()
            }
            var digits = ""
            while let last = token.last, last.isNumber {
                digits.insert(last, at: digits.startIndex)
                token.removeLast()
            }
            var amount = digits.isEmpty ? 1 : (Int(digits) ?? 1)
            if inverted { amount = -amount }

            guard !token.isEmpty else { throw NotationError("empty move") }
            guard let move = MoveTables.make(family: token, amount: amount) else {
                // `make` returns nil for an unknown family *and* for a whole rotation such as
                // `R4`. Only the first is an error, so resolve the family to tell them apart.
                if MoveTables.resolve(token) != nil { continue }
                throw NotationError("unrecognized move family: \(token)")
            }
            moves.append(move)
        }
        return moves
    }

    /// Whitespace-separated tokens, with `//` comments to end of line removed.
    ///
    /// Scanned by hand rather than with `range(of:)` so this module needs no Foundation import —
    /// the core is pure computation and is worth keeping that way.
    private static func tokens(of text: String) -> [String] {
        text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(dropComment)
            .flatMap { $0.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\r" }) }
            .map(String.init)
            .filter { !$0.isEmpty }
    }

    private static func dropComment(_ line: Substring) -> Substring {
        var previous: Character?
        for index in line.indices {
            if line[index] == "/", previous == "/" {
                return line[line.startIndex..<line.index(before: index)]
            }
            previous = line[index]
        }
        return line
    }

    public static func write(_ moves: [Move]) -> String {
        moves.map(\.notation).joined(separator: " ")
    }
}
