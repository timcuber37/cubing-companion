import SwiftUI

/// The native iOS app — see `SWIFT_PLAN.md`. S3 ships its first screen: connect a GAN cube and
/// mirror it. The logic is `CubingCore` and `CubeLink`, both checked against the TypeScript through
/// `vectors/`; this target is only UI.
@main
struct CubingApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
