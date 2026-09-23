/// Per-phase timing, pause detection and corpus scoring — the Swift counterpart of
/// `packages/metrics`.
///
/// Ported from `metrics.ts`, `pauses.ts` and `score.ts`. The reasoning behind each rule (why the
/// first phase covers one interval fewer, why inspection rotations are not charged, why pauses are
/// relative to the solver's own median gap) lives in those files and is not repeated here.

// MARK: - Baseline data

public struct Distribution: Sendable {
    public let n: Int
    public let mean, min, p10, p25, median, p75, p90, max: Double
}

public enum TimeWindow: String, Sendable, CaseIterable {
    case crossPlusOne = "cross+1"
    case pairs23 = "pairs2-3"
    case pair4
    case oll
    case pll
    case f2l
    case lastLayer = "last-layer"
    case total

    /// The phases whose durations make up this window; empty for `total`, which takes them all.
    var phases: [Phase] {
        switch self {
        case .crossPlusOne: [.cross, .f2l1]
        case .pairs23: [.f2l2, .f2l3]
        case .pair4: [.f2l4]
        case .oll: [.oll]
        case .pll: [.pll, .auf]
        case .f2l: [.cross, .f2l1, .f2l2, .f2l3, .f2l4]
        case .lastLayer: [.oll, .pll, .auf]
        case .total: []
        }
    }
}

public struct TurnBaseline: Sendable {
    public let key: String
    public let turns: Distribution
    public let rotations: Distribution?
}

public struct TimeBaseline: Sendable {
    public let window: TimeWindow
    public let seconds: Distribution
    public let tps: Distribution
    public let overheadCorrectionSeconds: Double
}

public struct Baselines: Sendable {
    public let generatedAt: String
    public let corpusSolves: Int
    public let timedSolves: Int
    public let timeEraFrom: Int
    public let turns: [TurnBaseline]
    public let times: [TimeBaseline]
}

// MARK: - Pauses

public struct PauseOptions: Sendable {
    public var minimumMs: Double = 250
    public var relativeToMedian: Double = 2.5
    public init() {}
}

public struct Pause: Sendable {
    /// The move the pause comes *before*.
    public let moveIndex: Int
    public let durationMs: Double
    /// Milliseconds from the first move of the solve.
    public let offsetMs: Double
}

public enum Pauses {
    /// Gaps between consecutive moves; nil where either end has no timestamp.
    public static func gaps(_ timestamps: ArraySlice<Double?>) -> [Double?] {
        let t = Array(timestamps)
        guard t.count > 1 else { return [] }
        return (1..<t.count).map { i in
            guard let previous = t[i - 1], let current = t[i] else { return nil }
            return current - previous
        }
    }

    public static func medianGapMs(_ timestamps: ArraySlice<Double?>) -> Double? {
        let usable = gaps(timestamps).compactMap { $0 }.sorted()
        guard !usable.isEmpty else { return nil }
        let middle = usable.count >> 1
        return usable.count % 2 == 1 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2
    }

    public static func thresholdMs(
        _ timestamps: ArraySlice<Double?>, _ options: PauseOptions = PauseOptions()
    ) -> Double {
        guard let median = medianGapMs(timestamps) else { return options.minimumMs }
        return Swift.max(options.minimumMs, median * options.relativeToMedian)
    }

    /// Every gap long enough to count as a pause, in move order. Indices are relative to the slice.
    public static func detect(
        _ timestamps: ArraySlice<Double?>, _ options: PauseOptions = PauseOptions()
    ) -> [Pause] {
        let threshold = thresholdMs(timestamps, options)
        let t = Array(timestamps)
        guard let start = t.first(where: { $0 != nil }) ?? nil else { return [] }
        var pauses: [Pause] = []
        for (i, gap) in gaps(timestamps).enumerated() {
            guard let gap, gap >= threshold else { continue }
            pauses.append(Pause(moveIndex: i + 1, durationMs: gap, offsetMs: t[i]! - start))
        }
        return pauses
    }
}

// MARK: - Metrics

public struct PhaseMetrics: Sendable {
    public let phase: Phase
    public let start: Int
    public let end: Int
    public let turns: Int
    public let rotations: Int
    public let slot: String?
    public let durationMs: Double?
    public let tps: Double?
    public let recognitionMs: Double?
    public let executionMs: Double?
    public let recognitionShare: Double?
    public let pauses: [Pause]
    public let pausedMs: Double
}

public struct SolveMetrics: Sendable {
    public let phases: [PhaseMetrics]
    public let durationMs: Double?
    public let turns: Int
    public let rotations: Int
    public let tps: Double?
    public let pauses: [Pause]
    public let longestPause: Pause?
    public let pausedMs: Double
    public let fluidity: Double?
    public let medianGapMs: Double?
    public let pauseThresholdMs: Double
}

public enum Metrics {
    /// The first move that is not a rotation, counted across the spans' moves.
    static func solveStart(_ spans: [PhaseSpan]) -> Int {
        var index = 0
        for span in spans {
            for move in span.moves {
                if !Segmentation.isRotation(move) { return index }
                index += 1
            }
        }
        return 0
    }

    private static func window(
        _ span: PhaseSpan, _ timestamps: [Double?], _ solveStart: Int
    ) -> (duration: Double?, recognition: Double?, execution: Double?) {
        // A skipped phase took no time, which is different from unknown.
        if span.end == span.start { return (0, 0, 0) }
        func at(_ i: Int) -> Double? { i >= 0 && i < timestamps.count ? timestamps[i] : nil }
        guard let first = at(Swift.max(span.start, solveStart)), let last = at(span.end - 1) else {
            return (nil, nil, nil)
        }
        let previousIndex = span.start - 1
        let previous = previousIndex >= solveStart ? at(previousIndex) : nil
        let from = previous ?? first
        return (last - from, first - from, last - first)
    }

    private static func ratePerSecond(_ count: Int, _ ms: Double?) -> Double? {
        guard let ms, ms > 0 else { return nil }
        return Double(count) * 1000 / ms
    }

    public static func compute(
        _ spans: [PhaseSpan], _ timestamps: [Double?], _ options: PauseOptions = PauseOptions()
    ) -> SolveMetrics {
        let start = solveStart(spans)
        let solving = timestamps.dropFirst(Swift.min(start, timestamps.count))
        let pauses = Pauses.detect(solving, options).map {
            Pause(moveIndex: $0.moveIndex + start, durationMs: $0.durationMs, offsetMs: $0.offsetMs)
        }

        let phases = spans.map { span -> PhaseMetrics in
            let (duration, recognition, execution) = window(span, timestamps, start)
            let inPhase = pauses.filter { $0.moveIndex >= span.start && $0.moveIndex < span.end }
            var share: Double?
            if let recognition, let duration, duration > 0 { share = recognition / duration }
            return PhaseMetrics(
                phase: span.phase, start: span.start, end: span.end,
                turns: span.turns, rotations: span.rotations, slot: span.slot,
                durationMs: duration, tps: ratePerSecond(span.turns, duration),
                recognitionMs: recognition, executionMs: execution, recognitionShare: share,
                pauses: inPhase, pausedMs: inPhase.reduce(0) { $0 + $1.durationMs })
        }

        let usable = solving.compactMap { $0 }
        let duration: Double? = usable.count >= 2 ? usable.last! - usable.first! : nil
        let turns = spans.reduce(0) { $0 + $1.turns }
        let pausedMs = pauses.reduce(0) { $0 + $1.durationMs }

        var fluidity: Double?
        if let duration, duration > 0 { fluidity = Swift.max(0, 1 - pausedMs / duration) }

        return SolveMetrics(
            phases: phases,
            durationMs: duration,
            turns: turns,
            rotations: spans.reduce(0) { $0 + $1.rotations },
            tps: ratePerSecond(turns, duration),
            pauses: pauses,
            // Strict `>`, so the first of equal pauses wins, as `reduce` does in the TypeScript.
            longestPause: pauses.reduce(nil) { worst, p in
                worst == nil || p.durationMs > worst!.durationMs ? p : worst
            },
            pausedMs: pausedMs,
            fluidity: fluidity,
            medianGapMs: Pauses.medianGapMs(solving),
            pauseThresholdMs: Pauses.thresholdMs(solving, options))
    }
}

// MARK: - Scoring

public enum Reference: String, Sendable { case corpus, you }

public struct Rated: Sendable {
    public let score: Double
    public let rating: Double
    public let value: Double
    public let distribution: Distribution
    public let reference: Reference
    public let overheadCorrected: Bool
}

public struct WindowScore: Sendable {
    public let window: TimeWindow
    public let seconds: Double
    public let turns: Int
    public let time: Rated?
}

public struct SolveScore: Sendable {
    public let components: [(label: String, rated: Rated)]
    public let rating: Double?
    public let phases: [(phase: Phase, turns: Rated?)]
    public let windows: [WindowScore]
    public let omitted: [(label: String, reason: String)]
    public let fluidity: Double?
    public let fluidityBand: String?
}

public enum Scoring {
    struct Anchors { let best: Double, worst: Double }
    static let corpusAnchors = Anchors(best: 10, worst: 6)
    static let selfAnchors = Anchors(best: 8, worst: 2)
    static let minSpreadFraction = 0.1
    public static let minOwnSolves = 5

    /// JavaScript's `Math.round`: halves go up, including negative ones.
    static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

    public static func corpusRank(_ value: Double, _ d: Distribution) -> Double {
        let knots: [(Double, Double)] = [
            (d.min, 0), (d.p10, 0.1), (d.p25, 0.25), (d.median, 0.5),
            (d.p75, 0.75), (d.p90, 0.9), (d.max, 1),
        ]
        if value <= knots[0].0 { return 0 }
        if value >= knots[knots.count - 1].0 { return 1 }
        for i in 1..<knots.count {
            let (x1, y1) = knots[i], (x0, y0) = knots[i - 1]
            if value <= x1 {
                if x1 == x0 { return y0 }
                return y0 + (value - x0) / (x1 - x0) * (y1 - y0)
            }
        }
        return 1
    }

    static func ratingFrom(_ value: Double, _ d: Distribution, _ anchors: Anchors) -> Double {
        let width = Swift.max(d.p90 - d.p10, abs(d.median) * minSpreadFraction)
        guard width > 0 else { return (anchors.best + anchors.worst) / 2 }
        let raw = anchors.best - (anchors.best - anchors.worst) * ((value - d.p10) / width)
        return jsRound(Swift.max(0, Swift.min(10, raw)) * 10) / 10
    }

    static func rate(
        _ value: Double, _ d: Distribution, anchors: Anchors = corpusAnchors,
        reference: Reference = .corpus, overheadCorrected: Bool = false
    ) -> Rated {
        Rated(
            score: 100 * (1 - corpusRank(value, d)), rating: ratingFrom(value, d, anchors),
            value: value, distribution: d, reference: reference,
            overheadCorrected: overheadCorrected)
    }

    /// Linear-interpolated percentiles, as `distributionOf` computes them.
    public static func distribution(of values: [Double]) -> Distribution? {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return nil }
        func at(_ p: Double) -> Double {
            let position = p * Double(sorted.count - 1)
            let lower = Int(position.rounded(.down)), upper = Int(position.rounded(.up))
            return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - Double(lower))
        }
        return Distribution(
            n: sorted.count, mean: sorted.reduce(0, +) / Double(sorted.count),
            min: sorted[0], p10: at(0.1), p25: at(0.25), median: at(0.5),
            p75: at(0.75), p90: at(0.9), max: sorted[sorted.count - 1])
    }

    public static func rateTurns(_ key: String, _ turns: Int) -> Rated? {
        baselines.turns.first { $0.key == key }.map { rate(Double(turns), $0.turns) }
    }

    public static func rateRotations(_ key: String, _ rotations: Int) -> Rated? {
        guard let d = baselines.turns.first(where: { $0.key == key })?.rotations else { return nil }
        return rate(Double(rotations), d)
    }

    public static func rateTime(_ window: TimeWindow, _ seconds: Double) -> Rated? {
        guard let baseline = baselines.times.first(where: { $0.window == window }) else {
            return nil
        }
        return rate(
            seconds, baseline.seconds, overheadCorrected: baseline.overheadCorrectionSeconds > 0)
    }

    public static func windows(_ metrics: SolveMetrics) -> [WindowScore] {
        TimeWindow.allCases.compactMap { window in
            let phases =
                window == .total
                ? metrics.phases : metrics.phases.filter { window.phases.contains($0.phase) }
            guard !phases.isEmpty, phases.allSatisfy({ $0.durationMs != nil }) else { return nil }
            let seconds = phases.reduce(0) { $0 + $1.durationMs! } / 1000
            return WindowScore(
                window: window, seconds: seconds, turns: phases.reduce(0) { $0 + $1.turns },
                time: rateTime(window, seconds))
        }
    }

    static let fluidityBands: [(atLeast: Double, label: String)] = [
        (0.9, "flowing"), (0.75, "steady"), (0.6, "hesitant"), (0, "stop-start"),
    ]

    public static func fluidityBand(_ fluidity: Double?) -> String? {
        guard let fluidity else { return nil }
        return fluidityBands.first { fluidity >= $0.atLeast }?.label
    }

    public static func score(
        _ metrics: SolveMetrics, rotationsObserved: Bool = true, recentDurationsMs: [Double] = []
    ) -> SolveScore {
        var components: [(label: String, rated: Rated)] = []
        var omitted: [(label: String, reason: String)] = []
        func add(_ label: String, _ rated: Rated?) {
            if let rated { components.append((label, rated)) }
        }

        let f2lPhases = TimeWindow.f2l.phases
        let shaped = metrics.phases.filter { f2lPhases.contains($0.phase) }
        if shaped.count == f2lPhases.count {
            add("efficiency", rateTurns("f2l", shaped.reduce(0) { $0 + $1.turns }))
        } else {
            omitted.append(("efficiency", "this solve has no complete cross and F2L to measure"))
        }
        if rotationsObserved {
            add("rotations", rateRotations("total", metrics.rotations))
        } else {
            omitted.append(
                ("rotations", "this cube cannot report them, so none were seen rather than none were made"))
        }

        let own = distribution(of: recentDurationsMs)
        if let duration = metrics.durationMs {
            if let own, own.n >= minOwnSolves {
                add("speed", rate(duration, own, anchors: selfAnchors, reference: .you))
            } else {
                omitted.append(
                    ("speed",
                     "rated against your own solves, and there are fewer than \(minOwnSolves) to compare with yet"))
            }
        } else {
            omitted.append(("speed", "this solve has no usable clock"))
        }

        let rating: Double? =
            components.isEmpty
            ? nil
            : jsRound(components.reduce(0) { $0 + $1.rated.rating } / Double(components.count) * 10)
                / 10

        return SolveScore(
            components: components,
            rating: rating,
            phases: metrics.phases.map { ($0.phase, rateTurns($0.phase.rawValue, $0.turns)) },
            windows: windows(metrics),
            omitted: omitted,
            fluidity: metrics.fluidity,
            fluidityBand: fluidityBand(metrics.fluidity))
    }
}
