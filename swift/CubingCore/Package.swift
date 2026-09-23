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
    products: [
        .library(name: "CubingCore", targets: ["CubingCore"]),
        .library(name: "CubeLink", targets: ["CubeLink"]),
    ],
    targets: [
        .target(name: "CubingCore"),
        // The GAN protocol, clock fit and tracker (S3). Separate from the pure core because it is
        // about a radio: it needs CommonCrypto now and CoreBluetooth next.
        .target(name: "CubeLink", dependencies: ["CubingCore"]),
        .testTarget(name: "CubeLinkTests", dependencies: ["CubeLink", "CubingCore"]),
        .testTarget(name: "CubingCoreTests", dependencies: ["CubingCore"]),
        // Separate so it builds in Release: no `@testable`. The phone runs the same benchmark
        // through the `CubingBench` app, since package tests cannot run on a device.
        .testTarget(name: "CubingBenchmarks", dependencies: ["CubingCore"]),
    ]
)
