/// Optional, explicit wide-move spelling for one face turn.
public enum Respell {
    public struct Result: Sendable {
        public let moves: [Move]
        public var text: String { Notation.write(moves) }
        public var rotations: Int { moves.filter { $0.familyIndex >= 15 }.count }
    }

    // SearchMoves face family order is U D L R F B.
    private static let equivalent: [(wide: String, axis: String, sign: Int)] = [
        ("Dw", "y", 1), ("Uw", "y", -1),
        ("Rw", "x", -1), ("Lw", "x", 1),
        ("Bw", "z", 1), ("Fw", "z", -1),
    ]

    public static func hasWideEquivalent(_ family: String) -> Bool {
        SearchMoves.faceFamilies.contains(family)
    }

    public static func asWide(_ moves: [Move], at index: Int) -> Result? {
        guard moves.indices.contains(index) else { return nil }
        let target = moves[index]
        guard target.familyIndex < 6 else { return nil }
        let equivalent = equivalent[Int(target.familyIndex)]
        let rotationAmount = target.amount == 2 ? 2 : equivalent.sign * target.amount
        let rewritten = Array(moves[..<index])
            + [Move(family: equivalent.wide, amount: target.amount),
               Move(family: equivalent.axis, amount: rotationAmount)]
            + Array(moves[(index + 1)...])
        return Result(moves: rewritten)
    }
}
