/// Converting between piece arrays and the 54-character facelet string.
///
/// Facelets are the project's interchange format — the README calls it out as deliberate, because
/// it is what every other tool in cubing speaks and it does not commit anyone to GAN's or
/// cubing.js's piece indexing. Everything crossing a boundary is a facelet string: the recorded
/// vectors, the smart cube's state reports, the planner's input.
///
/// Ported from `packages/engine/src/facelets.ts`.

public enum Facelets {
    /// Face letters in facelet-string order.
    static let letters = Array("URFDLB")
    public static let count = 54

    /// Our `Face` order is `U L F R B D`; the string's is `U R F D L B`. Two orderings, one of the
    /// easier things to get quietly wrong in a port.
    static let faceToStringIndex = [0, 4, 2, 1, 5, 3]
    static let stringIndexToFace = [0, 3, 2, 5, 1, 4]

    /// Facelets of each corner slot, U/D facelet first then clockwise seen from outside.
    /// Indexed by our corner numbering: URF, UBR, ULB, UFL, DFR, DLF, DBL, DRB.
    static let cornerFacelets: [[Int]] = [
        [8, 9, 20], [2, 45, 11], [0, 36, 47], [6, 18, 38],
        [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51],
    ]

    /// Edge slots: UF, UR, UB, UL, DF, DR, DB, DL, FR, FL, BR, BL.
    static let edgeFacelets: [[Int]] = [
        [7, 19], [5, 10], [1, 46], [3, 37],
        [28, 25], [32, 16], [34, 52], [30, 43],
        [23, 12], [21, 41], [48, 14], [50, 39],
    ]

    static let centerFacelets = [4, 40, 22, 13, 49, 31]

    /// The face a facelet belongs to on a solved cube — that is, the colour of that sticker.
    static func homeFace(of facelet: Int) -> Int { stringIndexToFace[facelet / 9] }

    private static func letter(forColour colour: Int) -> Character {
        letters[faceToStringIndex[colour]]
    }

    public static func string(from state: CubeState) -> String {
        var out = [Character](repeating: " ", count: count)

        for slot in 0..<numCenters {
            out[centerFacelets[slot]] = letter(forColour: Int(state.centers[slot]))
        }

        for slot in 0..<numCorners {
            let piece = Int(state.cp[slot])
            let orientation = Int(state.co[slot])
            let here = cornerFacelets[slot]
            let home = cornerFacelets[piece]
            for i in 0..<3 {
                // The sticker that sits at `home[i]` when solved lands `orientation` steps around.
                out[here[(i + orientation) % 3]] = letter(forColour: homeFace(of: home[i]))
            }
        }

        for slot in 0..<numEdges {
            let piece = Int(state.ep[slot])
            let orientation = Int(state.eo[slot])
            let here = edgeFacelets[slot]
            let home = edgeFacelets[piece]
            for i in 0..<2 {
                out[here[(i + orientation) % 2]] = letter(forColour: homeFace(of: home[i]))
            }
        }

        return String(out)
    }

    public struct FaceletError: Error, CustomStringConvertible {
        public let description: String
    }

    private static func key(_ faces: [Int]) -> [Int] { faces.sorted() }

    private static let cornerByFaces: [[Int]: Int] = {
        var map: [[Int]: Int] = [:]
        for (piece, facelets) in cornerFacelets.enumerated() {
            map[key(facelets.map(homeFace))] = piece
        }
        return map
    }()

    private static let edgeByFaces: [[Int]: Int] = {
        var map: [[Int]: Int] = [:]
        for (piece, facelets) in edgeFacelets.enumerated() {
            map[key(facelets.map(homeFace))] = piece
        }
        return map
    }()

    /// Parse a facelet string back into a state.
    ///
    /// Centres are read first, so a rotated cube parses as rotated rather than as scrambled. Like
    /// the TypeScript this checks coherence, not solvability: a twisted corner is a real thing a
    /// smart cube can report, and worth surfacing rather than rejecting here.
    public static func state(from facelets: String) throws -> CubeState {
        let chars = Array(facelets)
        guard chars.count == count else {
            throw FaceletError(description: "expected \(count) facelets, got \(chars.count)")
        }
        func colour(_ at: Int) throws -> Int {
            guard let index = letters.firstIndex(of: chars[at]) else {
                throw FaceletError(description: "unknown facelet character \(chars[at]) at \(at)")
            }
            return stringIndexToFace[index]
        }

        var state = CubeState.solved
        for slot in 0..<numCenters { state.centers[slot] = UInt8(try colour(centerFacelets[slot])) }

        for slot in 0..<numCorners {
            let colours = try cornerFacelets[slot].map(colour)
            guard let piece = cornerByFaces[key(colours)] else {
                throw FaceletError(description: "corner slot \(slot) has no such corner")
            }
            let reference = homeFace(of: cornerFacelets[piece][0])
            guard let orientation = colours.firstIndex(of: reference) else {
                throw FaceletError(description: "corner slot \(slot) is missing its U/D facelet")
            }
            state.cp[slot] = UInt8(piece)
            state.co[slot] = UInt8(orientation)
        }

        for slot in 0..<numEdges {
            let colours = try edgeFacelets[slot].map(colour)
            guard let piece = edgeByFaces[key(colours)] else {
                throw FaceletError(description: "edge slot \(slot) has no such edge")
            }
            state.ep[slot] = UInt8(piece)
            state.eo[slot] = colours[0] == homeFace(of: edgeFacelets[piece][0]) ? 0 : 1
        }
        return state
    }
}
