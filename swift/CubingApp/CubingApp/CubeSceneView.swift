import CubingCore
import SceneKit
import SwiftUI

/// The mirrored cube: 27 cubies painted from a facelet string, with the latest move animated.
///
/// Grown from the S1 spike (`spikes/CubeSpikes/Sources/CubeRenderSpike`), whose sticker mapping was
/// verified by eye. One rule makes it robust: **the facelet string is the truth and the animation is
/// decoration.** A turn rotates a layer, then every cubie is put back on its home square and the
/// whole cube is repainted from the tracked state. A turn cut short by the next move, a missed
/// animation or a reseed can therefore never leave the picture disagreeing with the model.
struct CubeSceneView: UIViewRepresentable {
    let facelets: String
    let lastMove: Move?
    let revision: Int

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = context.coordinator.scene
        view.backgroundColor = .clear
        view.allowsCameraControl = true
        view.antialiasingMode = .multisampling4X
        view.autoenablesDefaultLighting = false
        context.coordinator.cube.paint(facelets)
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        let coordinator = context.coordinator
        guard revision != coordinator.revision else { return }
        coordinator.revision = revision
        if let lastMove {
            coordinator.cube.animate(lastMove, then: facelets)
        } else {
            coordinator.cube.paint(facelets)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(revision: revision) }

    @MainActor
    final class Coordinator {
        let scene = SCNScene()
        let cube = CubeRig()
        var revision: Int

        init(revision: Int) {
            self.revision = revision
            scene.rootNode.addChildNode(cube.node)

            // From a corner, looking at the centre, so U, F and R face the viewer — the same view as
            // the web app's player. (Euler angles showed L/F/D in the spike; look-at avoids guessing.)
            let camera = SCNNode()
            camera.camera = SCNCamera()
            camera.camera?.fieldOfView = 38
            camera.position = SCNVector3(5.2, 5.6, 7.4)
            camera.look(at: SCNVector3(0, 0, 0))
            scene.rootNode.addChildNode(camera)

            let ambient = SCNNode()
            ambient.light = SCNLight()
            ambient.light?.type = .ambient
            ambient.light?.intensity = 650
            scene.rootNode.addChildNode(ambient)

            let key = SCNNode()
            key.light = SCNLight()
            key.light?.type = .directional
            key.light?.intensity = 500
            key.position = SCNVector3(3, 8, 6)
            key.look(at: SCNVector3(0, 0, 0))
            scene.rootNode.addChildNode(key)
        }
    }
}

/// Owns the cube's node rather than subclassing `SCNNode`, so it can be main-actor isolated —
/// which is what lets a SceneKit completion handler, called on the render thread, hand control back
/// safely.
@MainActor
final class CubeRig {
    let node = SCNNode()

    private static let size: Float = 1
    private static let gap: Float = 0.06
    private static let pitch = size + gap

    /// Matches the web app's palette.
    private static let colours: [Character: UIColor] = [
        "U": UIColor(red: 0.96, green: 0.96, blue: 0.96, alpha: 1),
        "R": UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1),
        "F": UIColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1),
        "D": UIColor(red: 0.92, green: 0.70, blue: 0.03, alpha: 1),
        "L": UIColor(red: 0.98, green: 0.45, blue: 0.09, alpha: 1),
        "B": UIColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1),
    ]
    private static let plastic = UIColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1)

    /// Cubies by home coordinate, which is what painting addresses — not where they currently are.
    private var cubies: [SIMD3<Int>: SCNNode] = [:]
    /// The layer mid-turn. Not `pivot`, which `SCNNode` already has.
    private var turning: SCNNode?
    private var target: String?

    init() {
        for x in -1...1 {
            for y in -1...1 {
                for z in -1...1 {
                    let box = SCNBox(
                        width: CGFloat(Self.size), height: CGFloat(Self.size),
                        length: CGFloat(Self.size), chamferRadius: 0.1)
                    box.materials = (0..<6).map { _ in
                        let material = SCNMaterial()
                        material.diffuse.contents = Self.plastic
                        material.lightingModel = .physicallyBased
                        material.roughness.contents = 0.45
                        return material
                    }
                    let cubie = SCNNode(geometry: box)
                    let home = SIMD3(x, y, z)
                    cubie.simdPosition = SIMD3<Float>(home) * Self.pitch
                    node.addChildNode(cubie)
                    cubies[home] = cubie
                }
            }
        }
    }

    /// SceneKit's box material order: front(+z), right(+x), back(-z), left(-x), top(+y), bottom(-y).
    private enum Side: Int { case front, right, back, left, top, bottom }

    /// Paint from a facelet string in URFDLB order, nine per face, rows then columns.
    func paint(_ facelets: String) {
        finishTurn()
        let chars = Array(facelets)
        guard chars.count == 54 else { return }
        func at(_ face: Int, _ row: Int, _ col: Int) -> Character { chars[face * 9 + row * 3 + col] }
        for row in 0..<3 {
            for col in 0..<3 {
                set(SIMD3(col - 1, 1, row - 1), .top, at(0, row, col))
                set(SIMD3(1, 1 - row, 1 - col), .right, at(1, row, col))
                set(SIMD3(col - 1, 1 - row, 1), .front, at(2, row, col))
                set(SIMD3(col - 1, -1, 1 - row), .bottom, at(3, row, col))
                set(SIMD3(-1, 1 - row, col - 1), .left, at(4, row, col))
                set(SIMD3(1 - col, 1 - row, -1), .back, at(5, row, col))
            }
        }
    }

    private func set(_ home: SIMD3<Int>, _ side: Side, _ colour: Character) {
        cubies[home]?.geometry?.materials[side.rawValue].diffuse.contents = Self.colours[colour] ?? Self.plastic
    }

    /// Turn the layer `move` names, then settle on `facelets`.
    ///
    /// Face turns only — which is all a GAN cube reports. Anything else just repaints.
    func animate(_ move: Move, then facelets: String) {
        // A turn still running is abandoned: the cube has moved on, and so should the picture.
        finishTurn()
        guard let (axis, inLayer) = Self.layer(move.family) else { return paint(facelets) }

        let pivot = SCNNode()
        node.addChildNode(pivot)
        for (home, cubie) in cubies where inLayer(home) {
            cubie.removeFromParentNode()
            pivot.addChildNode(cubie)
        }
        self.turning = pivot
        target = facelets

        let quarter = Float.pi / 2
        let angle = move.amount == 2 ? -2 * quarter : Float(-move.amount) * quarter
        let action = SCNAction.rotate(
            by: CGFloat(angle), around: SCNVector3(axis), duration: move.amount == 2 ? 0.14 : 0.09)
        action.timingMode = .easeOut
        // Called on SceneKit's render thread, so only an identifier crosses back, never the node.
        let turn = ObjectIdentifier(pivot)
        pivot.runAction(action) { [weak self] in
            Task { @MainActor in
                // Only the turn still in progress may settle the cube. A superseded one's handler,
                // should it still fire, would otherwise paint an older state over a newer one.
                guard let self, let turning = self.turning, ObjectIdentifier(turning) == turn else { return }
                self.finishTurn()
            }
        }
    }

    /// Put every cubie back on its home square, unturned, and paint the pending state if any.
    private func finishTurn() {
        guard let pivot = turning else { return }
        turning = nil
        pivot.removeAllActions()
        for (home, cubie) in cubies where cubie.parent === pivot {
            cubie.removeFromParentNode()
            cubie.simdTransform = matrix_identity_float4x4
            cubie.simdPosition = SIMD3<Float>(home) * Self.pitch
            node.addChildNode(cubie)
        }
        pivot.removeFromParentNode()
        if let target {
            self.target = nil
            paint(target)
        }
    }

    /// The axis a face turns about — clockwise seen from outside that face is a negative angle
    /// about its outward axis — and which home coordinates belong to its layer.
    private static func layer(_ family: String) -> (SIMD3<Float>, (SIMD3<Int>) -> Bool)? {
        switch family {
        case "U": (SIMD3(0, 1, 0), { $0.y == 1 })
        case "D": (SIMD3(0, -1, 0), { $0.y == -1 })
        case "R": (SIMD3(1, 0, 0), { $0.x == 1 })
        case "L": (SIMD3(-1, 0, 0), { $0.x == -1 })
        case "F": (SIMD3(0, 0, 1), { $0.z == 1 })
        case "B": (SIMD3(0, 0, -1), { $0.z == -1 })
        default: nil
        }
    }
}
