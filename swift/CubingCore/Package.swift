// swift-tools-version: 6.0
import PackageDescription

/// The Swift port of the pure core — see `SWIFT_PLAN.md`, phase S2.
///
/// Unlike `spikes/`, this is meant to survive. Every type here has a TypeScript counterpart in
/// `packages/`, and every one is checked against the recorded oracle in `vectors/` rather than
/// against hand-written expectations.
let package = Package(
    name: "CubingCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "CubingCore", targets: ["CubingCore"])],
    targets: [
        .target(name: "CubingCore"),
        .testTarget(name: "CubingCoreTests", dependencies: ["CubingCore"]),
        // Separate so it can run on an iPhone in Release: no `@testable`, no files from the Mac.
        .testTarget(name: "CubingBenchmarks", dependencies: ["CubingCore"]),
    ]
)
