import CubingSession
import SwiftData
import SwiftUI

/// The native iOS app — see `SWIFT_PLAN.md`. The logic is `CubingCore`, `CubeLink` and
/// `CubingSession`, each checked against the TypeScript through `vectors/`; this target is UI and
/// the wiring between them.
@main
struct CubingApp: App {
    private let container: ModelContainer
    @State private var cube: CubeModel
    @State private var solves: SolveModel
    @State private var plan: PlanModel

    init() {
        let container: ModelContainer
        do {
            container = try SolveLibrary.container()
        } catch {
            // A store that will not open is not recoverable from here, and running on without one
            // would record solves that are silently never kept.
            fatalError("Could not open the solve history: \(error)")
        }
        let cube = CubeModel()
        let solves = SolveModel(cube: cube, library: SolveLibrary(container))
        let plan = PlanModel()
        solves.onPlanTarget = { [weak plan] state in plan?.plan(for: state) }
        solves.onInspection = { [weak plan] in plan?.inspectionBegan() }
        self.container = container
        _cube = State(initialValue: cube)
        _solves = State(initialValue: solves)
        _plan = State(initialValue: plan)
    }

    var body: some Scene {
        WindowGroup { RootView(cube: cube, solves: solves, plan: plan) }
            .modelContainer(container)
    }
}
