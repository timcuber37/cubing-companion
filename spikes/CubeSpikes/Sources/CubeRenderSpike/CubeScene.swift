import SceneKit
import SwiftUI

/// Spike 1: can a SceneKit cube match what `cubing/twisty` gives us for free?
///
/// The web app's 3D player is cubing.js's, and it is good: it takes an arbitrary state, animates a
/// quarter turn at a tempo, and lets you drag to rotate. A Swift app has no equivalent, so this
/// asks whether building one is an afternoon or a project.
///
/// Three things have to work, and nothing else matters for the question:
///   1. build 27 cubies and paint them from a 54-character facelet string,
///   2. animate one quarter turn about a face,
///   3. drag to rotate the whole cube.
///
/// Throwaway. It is not architected, because architecting it would be doing the work rather than
/// sizing it.
enum CubeColors {
    /// Matches the web app's palette so the two can be compared side by side.
    static let map: [Character: NSColor] = [
        "U": NSColor(red: 0.96, green: 0.96, blue: 0.96, alpha: 1),  // white
        "R": NSColor(red: 0.96, green: 0.25, blue: 0.37, alpha: 1),  // red
        "F": NSColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1),  // green
        "D": NSColor(red: 0.98, green: 0.80, blue: 0.08, alpha: 1),  // yellow
        "L": NSColor(red: 0.98, green: 0.45, blue: 0.09, alpha: 1),  // orange
        "B": NSColor(red: 0.22, green: 0.51, blue: 0.96, alpha: 1),  // blue
    ]
    static let plastic = NSColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1)
}

/// Where each facelet index lives, as (axis, cubie coordinate) — the mapping a port has to get
/// right and the only genuinely fiddly part of this.
struct CubeGeometry {
    /// Facelet order is U, R, F, D, L, B; nine per face, reading rows top-left to bottom-right.
    static func faceletIndex(face: Int, row: Int, col: Int) -> Int { face * 9 + row * 3 + col }
}

final class CubeNode: SCNNode {
    private var cubies: [SCNNode] = []
    private let size: CGFloat = 1
    private let gap: CGFloat = 0.06

    override init() {
        super.init()
        build()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func build() {
        for x in -1...1 {
            for y in -1...1 {
                for z in -1...1 {
                    let box = SCNBox(width: size, height: size, length: size, chamferRadius: 0.08)
                    // Six materials per cubie, one per face, so a sticker is just a material colour.
                    box.materials = (0..<6).map { _ in
                        let m = SCNMaterial()
                        m.diffuse.contents = CubeColors.plastic
                        return m
                    }
                    let node = SCNNode(geometry: box)
                    node.position = SCNVector3(
                        CGFloat(x) * (size + gap),
                        CGFloat(y) * (size + gap),
                        CGFloat(z) * (size + gap)
                    )
                    node.name = "\(x),\(y),\(z)"
                    addChildNode(node)
                    cubies.append(node)
                }
            }
        }
    }

    private func cubie(_ x: Int, _ y: Int, _ z: Int) -> SCNNode? {
        childNode(withName: "\(x),\(y),\(z)", recursively: false)
    }

    /// SceneKit's box material order: front(+z), right(+x), back(-z), left(-x), top(+y), bottom(-y).
    private enum Side: Int { case front = 0, right = 1, back = 2, left = 3, top = 4, bottom = 5 }

    /// Paint the cube from a Kociemba facelet string — the project's interchange format.
    func apply(facelets: String) {
        let chars = Array(facelets)
        guard chars.count == 54 else { return }

        // U face: y = 1, rows run back(-z) to front(+z), cols left(-x) to right(+x).
        for row in 0..<3 {
            for col in 0..<3 {
                paint(cubie(col - 1, 1, row - 1), .top, chars[CubeGeometry.faceletIndex(face: 0, row: row, col: col)])
                paint(cubie(col - 1, -1, 1 - row), .bottom, chars[CubeGeometry.faceletIndex(face: 3, row: row, col: col)])
                paint(cubie(1, 1 - row, 1 - col), .right, chars[CubeGeometry.faceletIndex(face: 1, row: row, col: col)])
                paint(cubie(-1, 1 - row, col - 1), .left, chars[CubeGeometry.faceletIndex(face: 4, row: row, col: col)])
                paint(cubie(col - 1, 1 - row, 1), .front, chars[CubeGeometry.faceletIndex(face: 2, row: row, col: col)])
                paint(cubie(1 - col, 1 - row, -1), .back, chars[CubeGeometry.faceletIndex(face: 5, row: row, col: col)])
            }
        }
    }

    private func paint(_ node: SCNNode?, _ side: Side, _ colour: Character) {
        node?.geometry?.materials[side.rawValue].diffuse.contents =
            CubeColors.map[colour] ?? CubeColors.plastic
    }

    /// Animate a quarter turn of a face, then re-home the cubies so further turns still work.
    func turn(face: Character, clockwise: Bool = true, duration: TimeInterval = 0.25,
              completion: (() -> Void)? = nil) {
        let (axis, layer): (SCNVector3, (SCNNode) -> Bool) = switch face {
        case "U": (SCNVector3(0, 1, 0), { $0.position.y > 0.5 })
        case "D": (SCNVector3(0, -1, 0), { $0.position.y < -0.5 })
        case "R": (SCNVector3(1, 0, 0), { $0.position.x > 0.5 })
        case "L": (SCNVector3(-1, 0, 0), { $0.position.x < -0.5 })
        case "F": (SCNVector3(0, 0, 1), { $0.position.z > 0.5 })
        default: (SCNVector3(0, 0, -1), { $0.position.z < -0.5 })
        }

        // A temporary pivot the layer rotates around, unwound afterwards — the standard trick, and
        // the reason this is a dozen lines rather than per-cubie trigonometry.
        let pivot = SCNNode()
        addChildNode(pivot)
        let turning = childNodes.filter { $0 !== pivot && layer($0) }
        for node in turning {
            node.removeFromParentNode()
            pivot.addChildNode(node)
        }

        let angle = CGFloat.pi / 2 * (clockwise ? -1 : 1)
        pivot.runAction(.rotate(by: angle, around: axis, duration: duration)) { [weak self] in
            guard let self else { return }
            for node in pivot.childNodes {
                let world = node.worldTransform
                node.removeFromParentNode()
                self.addChildNode(node)
                node.transform = self.convertTransform(world, from: nil)
                // Snap back onto the lattice so float drift cannot accumulate over many turns.
                node.position = SCNVector3(
                    (node.position.x / (self.size + self.gap)).rounded() * (self.size + self.gap),
                    (node.position.y / (self.size + self.gap)).rounded() * (self.size + self.gap),
                    (node.position.z / (self.size + self.gap)).rounded() * (self.size + self.gap)
                )
            }
            pivot.removeFromParentNode()
            completion?()
        }
    }
}
