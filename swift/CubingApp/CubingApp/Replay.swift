import CubingCore
import CubingSession
import Observation
import SwiftUI

/// A solve, or an alternative to it, laid out for playback: every position, the moment each move
/// landed, and the moves as they read from the grip the replay is shown from.
///
/// The web app's `SolveDetail`, natively, with its two rules kept. **Scrubbing jumps** to a
/// precomputed position rather than animating, so the cube is exactly in step with the timeline at
/// any speed. **The grip is display-only**: positions stay in the cube's own frame, so an
/// alternative line's moves apply in the frame they were computed for, and the rotation is added
/// only as the cube is drawn.
struct ReplayLine {
    let states: [CubeState]
    /// Milliseconds from the first real turn to each position; `offsets[0]` is the start.
    let offsets: [Double]
    let moves: [Move]
    /// Each move as seen from the grip, so the text names the face the viewer sees turn.
    let moveText: [String]
    /// Set when this is an alternative: where it leaves your solve, and what it is.
    let branch: (at: Int, label: String)?

    /// Spacing for moves with no clock — an untimed solve, or an alternative nobody turned.
    static let fallbackGapMs = 120.0
}

@MainActor
@Observable
final class ReplayModel {
    let solve: ReplayLine
    /// The grip the replay is drawn from: cross colour down, the front inferred from the turns.
    let grip: Orientation
    let spans: [PhaseSpan]

    private(set) var line: ReplayLine
    private(set) var position = 0
    private(set) var playing = false
    var speed = 1.0
    /// The move that took the cube to `position`, when it got there by one step, so the renderer
    /// can animate it; nil after a jump.
    private(set) var stepped: Move?
    private(set) var revision = 0
    private var player: Task<Void, Never>?

    init?(_ record: SolveRecord) {
        guard let moves = try? Notation.parse(record.solution),
            let start = try? Facelets.state(from: record.startFacelets),
            let segmentation = Segmentation.segment(from: start, solution: moves).segmentation
        else { return nil }
        spans = segmentation.spans

        var states = [start]
        for move in moves { states.append(states.last!.applying([move])) }
        let firstTurn = moves.firstIndex { !Segmentation.isRotation($0) } ?? 0
        grip = Grip.infer(
            Grip.observations(spans),
            Grip.framesPuttingColourDown(states[min(firstTurn, states.count - 1)].centers.map(Int.init), segmentation.crossFace))

        // From the first real turn: inspection rotations cost the solve nothing, so the timeline
        // must not draw them as time spent.
        let base = record.moveTimestamps.dropFirst(firstTurn).compactMap { $0 }.first
        var offsets = [0.0]
        for i in moves.indices {
            let stamp = i < record.moveTimestamps.count ? record.moveTimestamps[i] : nil
            let previous = offsets.last!
            if let stamp, let base {
                // Clamped: a retimed stream can hand back a stamp that moves backwards.
                offsets.append(max(previous, stamp - base))
            } else {
                offsets.append(previous + ReplayLine.fallbackGapMs)
            }
        }
        let grip = grip
        solve = ReplayLine(
            states: states, offsets: offsets, moves: moves,
            moveText: moves.map { Notation.write(grip.rename([$0])) }, branch: nil)
        line = solve
    }

    /// What to paint: the position, seen from the grip.
    var facelets: String {
        Facelets.string(from: line.states[position].applying(grip.rotation))
    }

    /// `stepped`, renamed into the grip's frame — the layer that visibly turns on screen.
    var displayedMove: Move? { stepped.flatMap { grip.rename([$0]).first } }

    var elapsedMs: Double { line.offsets[position] }
    var durationMs: Double { line.offsets.last ?? 0 }

    // MARK: Transport

    func seek(_ index: Int) {
        pause()
        move(to: index, stepped: false)
    }

    func step(_ delta: Int) {
        pause()
        move(to: position + delta, stepped: delta == 1)
    }

    func togglePlaying() {
        playing ? pause() : play()
    }

    func play() {
        if position >= line.states.count - 1 { move(to: 0, stepped: false) }
        playing = true
        // Anchored once, at the moment play begins, so a late frame does not lose time.
        let startedAt = Date()
        let from = line.offsets[position]
        player = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let target = from + Date().timeIntervalSince(startedAt) * 1000 * speed
                var next = position
                while next < line.offsets.count - 1, line.offsets[next + 1] <= target { next += 1 }
                if next != position { move(to: next, stepped: next == position + 1) }
                if next >= line.offsets.count - 1 {
                    playing = false
                    return
                }
                try? await Task.sleep(nanoseconds: 16_000_000)
            }
        }
    }

    func pause() {
        player?.cancel()
        player = nil
        playing = false
    }

    private func move(to index: Int, stepped wasStep: Bool) {
        let clamped = max(0, min(line.states.count - 1, index))
        stepped = wasStep && clamped == position + 1 ? line.moves[position] : nil
        position = clamped
        revision += 1
    }

    // MARK: Alternatives

    /// Swap the cube onto an alternative, parked where it leaves your solve. It keeps the real
    /// prefix, so you see the solve arrive at the decision and then go the other way, and takes the
    /// alternative at an even tempo: nobody turned it, and inventing timings would be a lie the
    /// timeline then drew.
    func playBranch(at: Int, moves text: String, label: String) {
        guard let moves = try? Notation.parse(text), at < solve.states.count else { return }
        var states = Array(solve.states[...at])
        var offsets = Array(solve.offsets[...at])
        for move in moves {
            states.append(states.last!.applying([move]))
            offsets.append(offsets.last! + ReplayLine.fallbackGapMs)
        }
        let grip = grip
        line = ReplayLine(
            states: states, offsets: offsets, moves: Array(solve.moves[..<at]) + moves,
            moveText: Array(solve.moveText[..<at]) + moves.map { Notation.write(grip.rename([$0])) },
            branch: (at, label))
        pause()
        move(to: at, stepped: false)
        play()
    }

    func returnToSolve() {
        let at = line.branch?.at ?? position
        line = solve
        pause()
        move(to: at, stepped: false)
    }

    /// The phase the current position falls in, for the label under the cube.
    var currentPhase: Phase? {
        guard line.branch == nil else { return nil }
        return spans.first { position > $0.start && position <= $0.end }?.phase ?? spans.first?.phase
    }
}

/// The replay: the cube, a scrubber over the solve's own timeline, and the transport.
struct ReplayView: View {
    let model: ReplayModel

    var body: some View {
        VStack(spacing: 10) {
            CubeSceneView(facelets: model.facelets, lastMove: model.displayedMove, revision: model.revision)
                .frame(height: 240)
            if let branch = model.line.branch {
                HStack {
                    Label(branch.label, systemImage: "arrow.triangle.branch").font(.footnote.bold())
                    Spacer()
                    Button("Back to my solve", action: model.returnToSolve).font(.footnote)
                }
                .foregroundStyle(.orange)
            }
            PhaseBands(model: model)
            Slider(
                value: Binding(get: { Double(model.position) }, set: { model.seek(Int($0.rounded())) }),
                in: 0...Double(max(1, model.line.states.count - 1)), step: 1)
            HStack {
                Text("\(Format.time(model.elapsedMs)) / \(Format.time(model.durationMs))")
                    .font(.footnote.monospacedDigit())
                Spacer()
                Button { model.step(-1) } label: { Image(systemName: "backward.frame") }
                Button { model.togglePlaying() } label: {
                    Image(systemName: model.playing ? "pause.fill" : "play.fill").frame(width: 28)
                }
                Button { model.step(1) } label: { Image(systemName: "forward.frame") }
                Spacer()
                Menu {
                    ForEach([0.25, 0.5, 1.0], id: \.self) { speed in
                        Button("\(speed == 1 ? "1" : String(speed))×") { model.speed = speed }
                    }
                } label: {
                    Text("\(model.speed == 1 ? "1" : String(model.speed))×").font(.footnote.monospacedDigit())
                }
            }
            .buttonStyle(.borderless)
            MoveStrip(model: model)
        }
    }
}

/// The phases drawn to scale along the solve's timeline, each tappable to jump to its start.
private struct PhaseBands: View {
    let model: ReplayModel

    var body: some View {
        GeometryReader { geometry in
            let total = max(1, model.solve.offsets.last ?? 1)
            HStack(spacing: 1) {
                ForEach(Array(model.spans.enumerated()), id: \.offset) { i, span in
                    let from = model.solve.offsets[min(span.start, model.solve.offsets.count - 1)]
                    let to = model.solve.offsets[min(span.end, model.solve.offsets.count - 1)]
                    Rectangle()
                        .fill(Self.colour(i).opacity(span.turns == 0 ? 0.2 : 0.75))
                        .frame(width: max(2, geometry.size.width * (to - from) / total))
                        .onTapGesture { model.seek(span.start) }
                        .accessibilityLabel(Format.phase(span.phase))
                }
            }
        }
        .frame(height: 10)
        .clipShape(Capsule())
    }

    static func colour(_ i: Int) -> Color {
        [.blue, .teal, .green, .mint, .cyan, .orange, .pink, .purple][i % 8]
    }
}

/// The moves, current one picked out, scrolled to keep it in view.
private struct MoveStrip: View {
    let model: ReplayModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(model.line.moveText.enumerated()), id: \.offset) { i, text in
                        let branched = model.line.branch.map { i >= $0.at } ?? false
                        Text(text)
                            .font(.callout.monospaced().weight(i == model.position - 1 ? .bold : .regular))
                            .foregroundStyle(i == model.position - 1 ? Color.accentColor : branched ? .orange : i < model.position ? .secondary : .primary)
                            .id(i)
                            .onTapGesture { model.seek(i + 1) }
                    }
                }
            }
            .onChange(of: model.position) { _, position in
                withAnimation { proxy.scrollTo(max(0, position - 1), anchor: .center) }
            }
        }
    }
}
