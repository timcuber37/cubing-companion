import Foundation
import SceneKit
import AppKit

/// Renders the spike cube offscreen so it can actually be looked at.
///
/// A renderer spike whose output nobody sees answers nothing — the question is whether the facelet
/// mapping and the turn animation are *right*, and that is a visual fact. So this draws to a PNG
/// rather than opening a window, which also means it runs without a GUI session.

let solved = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"
/// After `R U R' U'` — a state where every face has at least two colours, so a mapping error
/// anywhere is visible rather than hidden behind a solved face.
let sexy = "UUUUUUFRFRRDRRDRRURRUFFUFFDDDDDDDDBLLBLLBLLFLUBLUBLUBB"

/// Twist one layer without animating, to check the layer *selection* rather than the tween.
///
/// The animation itself is a standard SceneKit pivot; the part that can be wrong is which cubies
/// get reparented onto the pivot. Frozen at 45° that is obvious at a glance, and an offscreen
/// renderer has no run loop to advance an action anyway.
func twistR(_ cube: CubeNode) {
    let pivot = SCNNode()
    cube.addChildNode(pivot)
    for node in cube.childNodes where node !== pivot && node.position.x > 0.5 {
        node.removeFromParentNode()
        pivot.addChildNode(node)
    }
    pivot.eulerAngles = SCNVector3(-CGFloat.pi / 4, 0, 0)
}

func render(facelets: String, to path: String, spin: CGFloat = 0, twist: Bool = false) {
    let scene = SCNScene()
    let cube = CubeNode()
    cube.apply(facelets: facelets)
    if twist { twistR(cube) }
    // Left unrotated; the camera moves instead. Euler angles here meant guessing at sign
    // conventions to find the conventional view, and the first guess showed L/F/D rather than
    // U/F/R — a camera at a corner looking at the origin is unambiguous.
    cube.eulerAngles = SCNVector3(0, spin, 0)
    scene.rootNode.addChildNode(cube)

    let camera = SCNNode()
    camera.camera = SCNCamera()
    camera.camera?.usesOrthographicProjection = true
    camera.camera?.orthographicScale = 3.2
    // The three-quarter view every cubing tool uses: up, front and right all visible at once.
    camera.position = SCNVector3(7, 6, 9)
    camera.look(at: SCNVector3Zero)
    scene.rootNode.addChildNode(camera)

    let light = SCNNode()
    light.light = SCNLight()
    light.light?.type = .directional
    light.light?.intensity = 700
    light.position = SCNVector3(5, 8, 10)
    light.look(at: SCNVector3Zero)
    scene.rootNode.addChildNode(light)

    let ambient = SCNNode()
    ambient.light = SCNLight()
    ambient.light?.type = .ambient
    ambient.light?.intensity = 600
    scene.rootNode.addChildNode(ambient)

    guard let device = MTLCreateSystemDefaultDevice() else {
        print("no Metal device"); exit(1)
    }
    let renderer = SCNRenderer(device: device, options: nil)
    renderer.scene = scene
    renderer.pointOfView = camera
    // Matches the app's neutral-950 ground.
    renderer.scene?.background.contents = NSColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)

    let image = renderer.snapshot(atTime: 0, with: CGSize(width: 600, height: 600),
                                  antialiasingMode: .multisampling4X)
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        print("could not encode"); exit(1)
    }
    try? png.write(to: URL(fileURLWithPath: path))
    print("  wrote \(path)")
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
render(facelets: solved, to: "\(out)/cube-solved.png")
render(facelets: sexy, to: "\(out)/cube-scrambled.png")
// The back three faces, to check the mapping on the sides the first view hides.
render(facelets: sexy, to: "\(out)/cube-scrambled-back.png", spin: .pi)
render(facelets: solved, to: "\(out)/cube-midturn.png", twist: true)
