// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run swift-tables
// Source: packages/metrics/src/baselines.generated.ts (B1's reco.nz corpus).

public let baselines = Baselines(
    generatedAt: "2026-08-25",
    corpusSolves: 9865,
    timedSolves: 3114,
    timeEraFrom: 2021,
    turns: [
        TurnBaseline(
            key: "cross",
            turns: Distribution(n: 4478, mean: 6.4364, min: 1.0, p10: 4.0, p25: 5.0, median: 6.0, p75: 7.0, p90: 9.0, max: 27.0),
            rotations: Distribution(n: 4478, mean: 0.2354, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 0.0, p90: 1.0, max: 6.0)),
        TurnBaseline(
            key: "f2l1",
            turns: Distribution(n: 4478, mean: 6.1362, min: 2.0, p10: 3.0, p25: 4.0, median: 6.0, p75: 8.0, p90: 9.0, max: 20.0),
            rotations: Distribution(n: 4478, mean: 0.3515, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 1.0, p90: 1.0, max: 4.0)),
        TurnBaseline(
            key: "f2l2",
            turns: Distribution(n: 4478, mean: 7.3671, min: 2.0, p10: 4.0, p25: 6.0, median: 7.0, p75: 8.0, p90: 10.0, max: 21.0),
            rotations: Distribution(n: 4478, mean: 0.5556, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 1.0, p90: 1.0, max: 6.0)),
        TurnBaseline(
            key: "f2l3",
            turns: Distribution(n: 4478, mean: 7.5788, min: 2.0, p10: 4.0, p25: 6.0, median: 8.0, p75: 8.0, p90: 11.0, max: 38.0),
            rotations: Distribution(n: 4478, mean: 0.5732, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 1.0, p90: 1.0, max: 5.0)),
        TurnBaseline(
            key: "f2l4",
            turns: Distribution(n: 4478, mean: 8.0284, min: 2.0, p10: 4.0, p25: 7.0, median: 8.0, p75: 9.0, p90: 12.0, max: 41.0),
            rotations: Distribution(n: 4478, mean: 0.4792, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 1.0, p90: 1.0, max: 7.0)),
        TurnBaseline(
            key: "oll",
            turns: Distribution(n: 4478, mean: 10.5255, min: 4.0, p10: 7.0, p25: 9.0, median: 10.0, p75: 12.0, p90: 14.0, max: 43.0),
            rotations: Distribution(n: 4478, mean: 0.0851, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 0.0, p90: 0.0, max: 4.0)),
        TurnBaseline(
            key: "pll",
            turns: Distribution(n: 4478, mean: 14.7017, min: 1.0, p10: 10.0, p25: 12.0, median: 15.0, p75: 17.0, p90: 19.0, max: 68.0),
            rotations: Distribution(n: 4478, mean: 0.2722, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 0.0, p90: 1.0, max: 8.0)),
        TurnBaseline(
            key: "cross+1",
            turns: Distribution(n: 4478, mean: 12.5726, min: 4.0, p10: 9.0, p25: 11.0, median: 12.0, p75: 14.0, p90: 16.0, max: 37.0),
            rotations: Distribution(n: 4478, mean: 0.5869, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 1.0, p90: 2.0, max: 7.0)),
        TurnBaseline(
            key: "f2l",
            turns: Distribution(n: 4478, mean: 35.5469, min: 18.0, p10: 29.0, p25: 32.0, median: 35.0, p75: 39.0, p90: 42.0, max: 77.0),
            rotations: Distribution(n: 4478, mean: 2.195, min: 0.0, p10: 0.0, p25: 1.0, median: 2.0, p75: 3.0, p90: 4.0, max: 11.0)),
        TurnBaseline(
            key: "last-layer",
            turns: Distribution(n: 4478, mean: 25.2271, min: 11.0, p10: 20.0, p25: 22.0, median: 25.0, p75: 28.0, p90: 31.0, max: 79.0),
            rotations: Distribution(n: 4478, mean: 0.3573, min: 0.0, p10: 0.0, p25: 0.0, median: 0.0, p75: 0.0, p90: 1.0, max: 8.0)),
        TurnBaseline(
            key: "total",
            turns: Distribution(n: 4478, mean: 60.774, min: 34.0, p10: 52.0, p25: 56.0, median: 61.0, p75: 65.0, p90: 70.0, max: 115.0),
            rotations: Distribution(n: 4478, mean: 4.0016, min: 0.0, p10: 2.0, p25: 3.0, median: 4.0, p75: 5.0, p90: 7.0, max: 16.0)),
    ],
    times: [
        TimeBaseline(
            window: .crossPlusOne,
            seconds: Distribution(n: 3113, mean: 1.2345, min: 0.3195, p10: 0.7895, p25: 0.9395, median: 1.1695, p75: 1.4395, p90: 1.7695, max: 5.0695),
            tps: Distribution(n: 3113, mean: 10.4541, min: 4.0619, p10: 7.4379, p25: 8.623, median: 10.2399, p75: 12.0055, p90: 13.8004, max: 25.0362),
            overheadCorrectionSeconds: 0.23),
        TimeBaseline(
            window: .pairs23,
            seconds: Distribution(n: 3114, mean: 1.4395, min: 0.46, p10: 0.933, p25: 1.13, median: 1.37, p75: 1.67, p90: 2.007, max: 5.58),
            tps: Distribution(n: 3114, mean: 10.7204, min: 4.0268, p10: 7.6648, p25: 8.9552, median: 10.573, p75: 12.3682, p90: 14.0, max: 20.8333),
            overheadCorrectionSeconds: 0.0),
        TimeBaseline(
            window: .pair4,
            seconds: Distribution(n: 3113, mean: 0.6978, min: 0.1, p10: 0.37, p25: 0.5, median: 0.65, p75: 0.83, p90: 1.07, max: 7.94),
            tps: Distribution(n: 3113, mean: 12.3559, min: 1.0076, p10: 8.0305, p25: 9.8592, median: 12.1622, p75: 14.8148, p90: 17.0213, max: 30.7692),
            overheadCorrectionSeconds: 0.0),
        TimeBaseline(
            window: .oll,
            seconds: Distribution(n: 3030, mean: 1.0934, min: 0.3, p10: 0.63, p25: 0.77, median: 0.98, p75: 1.27, p90: 1.7, max: 18.78),
            tps: Distribution(n: 3030, mean: 10.9045, min: 1.1182, p10: 7.5169, p25: 8.8496, median: 10.5769, p75: 12.6091, p90: 14.9254, max: 24.2857),
            overheadCorrectionSeconds: 0.0),
        TimeBaseline(
            window: .pll,
            seconds: Distribution(n: 2637, mean: 1.0105, min: 0.0064, p10: 0.5764, p25: 0.7464, median: 0.9464, p75: 1.1864, p90: 1.4664, max: 24.9064),
            tps: Distribution(n: 2637, mean: 16.4482, min: 0.0402, p10: 9.7478, p25: 12.4288, median: 15.5716, p75: 19.1784, p90: 23.9458, max: 155.898),
            overheadCorrectionSeconds: 0.394),
        TimeBaseline(
            window: .f2l,
            seconds: Distribution(n: 3114, mean: 3.3711, min: 1.4695, p10: 2.4695, p25: 2.7995, median: 3.2395, p75: 3.7995, p90: 4.4695, max: 10.6995),
            tps: Distribution(n: 3114, mean: 10.6842, min: 3.0842, p10: 8.3398, p25: 9.3706, median: 10.6075, p75: 11.8967, p90: 13.1109, max: 18.4768),
            overheadCorrectionSeconds: 0.23),
        TimeBaseline(
            window: .lastLayer,
            seconds: Distribution(n: 3114, mean: 1.8694, min: 0.1164, p10: 1.1264, p25: 1.4764, median: 1.8264, p75: 2.1864, p90: 2.6164, max: 26.1764),
            tps: Distribution(n: 3114, mean: 13.3233, min: 0.3438, p10: 9.1483, p25: 10.876, median: 12.9779, p75: 15.3159, p90: 17.741, max: 68.2993),
            overheadCorrectionSeconds: 0.394),
        TimeBaseline(
            window: .total,
            seconds: Distribution(n: 3114, mean: 5.2264, min: 2.056, p10: 3.919, p25: 4.396, median: 5.076, p75: 5.886, p90: 6.746, max: 12.296),
            tps: Distribution(n: 3114, mean: 11.4665, min: 4.5543, p10: 8.9859, p25: 10.0639, median: 11.419, p75: 12.7632, p90: 13.993, max: 20.1733),
            overheadCorrectionSeconds: 0.624),
    ]
)
