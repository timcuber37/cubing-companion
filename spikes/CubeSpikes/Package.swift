// swift-tools-version: 6.0
import PackageDescription

/// Throwaway spikes for the Swift migration — see `SWIFT_PLAN.md`, phase S1.
///
/// Each one answers a question that changes the plan if the answer is no, and none of it is
/// intended to survive into the real app. It exists to be run once and believed.
let package = Package(
    name: "CubeSpikes",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "CubeSpikes"),
        .executableTarget(name: "CubeRenderSpike"),
        .testTarget(name: "CubeSpikesTests", dependencies: ["CubeSpikes"]),
    ]
)
