// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run generate -w @cubing-companion/metrics
// Source: B1's reco.nz corpus (see scripts/generate-baselines.ts).
//
// Turn counts: 4,478 clean solves, all eras.
// Times: 3,114 clean solves from 2021 onwards, because times
// drift ~35% across the corpus's span while move counts drift ~9%.
//
// The cross+1 and PLL time distributions have stackmat dead time subtracted; see `TimerOverhead`
// in ./baselines.ts for how it is estimated and how far to trust it.

import type { Baselines } from "./baselines.ts";

export const BASELINES: Baselines = {
  "generatedAt": "2026-08-25",
  "corpusSolves": 9865,
  "timedSolves": 3114,
  "timeEraFrom": 2021,
  "turns": [
    {
      "key": "cross",
      "turns": {
        "n": 4478,
        "mean": 6.4364,
        "min": 1,
        "p10": 4,
        "p25": 5,
        "median": 6,
        "p75": 7,
        "p90": 9,
        "max": 27
      },
      "rotations": {
        "n": 4478,
        "mean": 0.2354,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 0,
        "p90": 1,
        "max": 6
      }
    },
    {
      "key": "f2l1",
      "turns": {
        "n": 4478,
        "mean": 6.1362,
        "min": 2,
        "p10": 3,
        "p25": 4,
        "median": 6,
        "p75": 8,
        "p90": 9,
        "max": 20
      },
      "rotations": {
        "n": 4478,
        "mean": 0.3515,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 1,
        "p90": 1,
        "max": 4
      }
    },
    {
      "key": "f2l2",
      "turns": {
        "n": 4478,
        "mean": 7.3671,
        "min": 2,
        "p10": 4,
        "p25": 6,
        "median": 7,
        "p75": 8,
        "p90": 10,
        "max": 21
      },
      "rotations": {
        "n": 4478,
        "mean": 0.5556,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 1,
        "p90": 1,
        "max": 6
      }
    },
    {
      "key": "f2l3",
      "turns": {
        "n": 4478,
        "mean": 7.5788,
        "min": 2,
        "p10": 4,
        "p25": 6,
        "median": 8,
        "p75": 8,
        "p90": 11,
        "max": 38
      },
      "rotations": {
        "n": 4478,
        "mean": 0.5732,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 1,
        "p90": 1,
        "max": 5
      }
    },
    {
      "key": "f2l4",
      "turns": {
        "n": 4478,
        "mean": 8.0284,
        "min": 2,
        "p10": 4,
        "p25": 7,
        "median": 8,
        "p75": 9,
        "p90": 12,
        "max": 41
      },
      "rotations": {
        "n": 4478,
        "mean": 0.4792,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 1,
        "p90": 1,
        "max": 7
      }
    },
    {
      "key": "oll",
      "turns": {
        "n": 4478,
        "mean": 10.5255,
        "min": 4,
        "p10": 7,
        "p25": 9,
        "median": 10,
        "p75": 12,
        "p90": 14,
        "max": 43
      },
      "rotations": {
        "n": 4478,
        "mean": 0.0851,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 0,
        "p90": 0,
        "max": 4
      }
    },
    {
      "key": "pll",
      "turns": {
        "n": 4478,
        "mean": 14.7017,
        "min": 1,
        "p10": 10,
        "p25": 12,
        "median": 15,
        "p75": 17,
        "p90": 19,
        "max": 68
      },
      "rotations": {
        "n": 4478,
        "mean": 0.2722,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 0,
        "p90": 1,
        "max": 8
      }
    },
    {
      "key": "cross+1",
      "turns": {
        "n": 4478,
        "mean": 12.5726,
        "min": 4,
        "p10": 9,
        "p25": 11,
        "median": 12,
        "p75": 14,
        "p90": 16,
        "max": 37
      },
      "rotations": {
        "n": 4478,
        "mean": 0.5869,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 1,
        "p90": 2,
        "max": 7
      }
    },
    {
      "key": "f2l",
      "turns": {
        "n": 4478,
        "mean": 35.5469,
        "min": 18,
        "p10": 29,
        "p25": 32,
        "median": 35,
        "p75": 39,
        "p90": 42,
        "max": 77
      },
      "rotations": {
        "n": 4478,
        "mean": 2.195,
        "min": 0,
        "p10": 0,
        "p25": 1,
        "median": 2,
        "p75": 3,
        "p90": 4,
        "max": 11
      }
    },
    {
      "key": "last-layer",
      "turns": {
        "n": 4478,
        "mean": 25.2271,
        "min": 11,
        "p10": 20,
        "p25": 22,
        "median": 25,
        "p75": 28,
        "p90": 31,
        "max": 79
      },
      "rotations": {
        "n": 4478,
        "mean": 0.3573,
        "min": 0,
        "p10": 0,
        "p25": 0,
        "median": 0,
        "p75": 0,
        "p90": 1,
        "max": 8
      }
    },
    {
      "key": "total",
      "turns": {
        "n": 4478,
        "mean": 60.774,
        "min": 34,
        "p10": 52,
        "p25": 56,
        "median": 61,
        "p75": 65,
        "p90": 70,
        "max": 115
      },
      "rotations": {
        "n": 4478,
        "mean": 4.0016,
        "min": 0,
        "p10": 2,
        "p25": 3,
        "median": 4,
        "p75": 5,
        "p90": 7,
        "max": 16
      }
    }
  ],
  "times": [
    {
      "window": "cross+1",
      "seconds": {
        "n": 3113,
        "mean": 1.2345,
        "min": 0.3195,
        "p10": 0.7895,
        "p25": 0.9395,
        "median": 1.1695,
        "p75": 1.4395,
        "p90": 1.7695,
        "max": 5.0695
      },
      "tps": {
        "n": 3113,
        "mean": 10.4541,
        "min": 4.0619,
        "p10": 7.4379,
        "p25": 8.623,
        "median": 10.2399,
        "p75": 12.0055,
        "p90": 13.8004,
        "max": 25.0362
      },
      "overheadCorrectionSeconds": 0.23
    },
    {
      "window": "pairs2-3",
      "seconds": {
        "n": 3114,
        "mean": 1.4395,
        "min": 0.46,
        "p10": 0.933,
        "p25": 1.13,
        "median": 1.37,
        "p75": 1.67,
        "p90": 2.007,
        "max": 5.58
      },
      "tps": {
        "n": 3114,
        "mean": 10.7204,
        "min": 4.0268,
        "p10": 7.6648,
        "p25": 8.9552,
        "median": 10.573,
        "p75": 12.3682,
        "p90": 14,
        "max": 20.8333
      },
      "overheadCorrectionSeconds": 0
    },
    {
      "window": "pair4",
      "seconds": {
        "n": 3113,
        "mean": 0.6978,
        "min": 0.1,
        "p10": 0.37,
        "p25": 0.5,
        "median": 0.65,
        "p75": 0.83,
        "p90": 1.07,
        "max": 7.94
      },
      "tps": {
        "n": 3113,
        "mean": 12.3559,
        "min": 1.0076,
        "p10": 8.0305,
        "p25": 9.8592,
        "median": 12.1622,
        "p75": 14.8148,
        "p90": 17.0213,
        "max": 30.7692
      },
      "overheadCorrectionSeconds": 0
    },
    {
      "window": "oll",
      "seconds": {
        "n": 3030,
        "mean": 1.0934,
        "min": 0.3,
        "p10": 0.63,
        "p25": 0.77,
        "median": 0.98,
        "p75": 1.27,
        "p90": 1.7,
        "max": 18.78
      },
      "tps": {
        "n": 3030,
        "mean": 10.9045,
        "min": 1.1182,
        "p10": 7.5169,
        "p25": 8.8496,
        "median": 10.5769,
        "p75": 12.6091,
        "p90": 14.9254,
        "max": 24.2857
      },
      "overheadCorrectionSeconds": 0
    },
    {
      "window": "pll",
      "seconds": {
        "n": 2637,
        "mean": 1.0105,
        "min": 0.0064,
        "p10": 0.5764,
        "p25": 0.7464,
        "median": 0.9464,
        "p75": 1.1864,
        "p90": 1.4664,
        "max": 24.9064
      },
      "tps": {
        "n": 2637,
        "mean": 16.4482,
        "min": 0.0402,
        "p10": 9.7478,
        "p25": 12.4288,
        "median": 15.5716,
        "p75": 19.1784,
        "p90": 23.9458,
        "max": 155.898
      },
      "overheadCorrectionSeconds": 0.394
    },
    {
      "window": "f2l",
      "seconds": {
        "n": 3114,
        "mean": 3.3711,
        "min": 1.4695,
        "p10": 2.4695,
        "p25": 2.7995,
        "median": 3.2395,
        "p75": 3.7995,
        "p90": 4.4695,
        "max": 10.6995
      },
      "tps": {
        "n": 3114,
        "mean": 10.6842,
        "min": 3.0842,
        "p10": 8.3398,
        "p25": 9.3706,
        "median": 10.6075,
        "p75": 11.8967,
        "p90": 13.1109,
        "max": 18.4768
      },
      "overheadCorrectionSeconds": 0.23
    },
    {
      "window": "last-layer",
      "seconds": {
        "n": 3114,
        "mean": 1.8694,
        "min": 0.1164,
        "p10": 1.1264,
        "p25": 1.4764,
        "median": 1.8264,
        "p75": 2.1864,
        "p90": 2.6164,
        "max": 26.1764
      },
      "tps": {
        "n": 3114,
        "mean": 13.3233,
        "min": 0.3438,
        "p10": 9.1483,
        "p25": 10.876,
        "median": 12.9779,
        "p75": 15.3159,
        "p90": 17.741,
        "max": 68.2993
      },
      "overheadCorrectionSeconds": 0.394
    },
    {
      "window": "total",
      "seconds": {
        "n": 3114,
        "mean": 5.2264,
        "min": 2.056,
        "p10": 3.919,
        "p25": 4.396,
        "median": 5.076,
        "p75": 5.886,
        "p90": 6.746,
        "max": 12.296
      },
      "tps": {
        "n": 3114,
        "mean": 11.4665,
        "min": 4.5543,
        "p10": 8.9859,
        "p25": 10.0639,
        "median": 11.419,
        "p75": 12.7632,
        "p90": 13.993,
        "max": 20.1733
      },
      "overheadCorrectionSeconds": 0.624
    }
  ],
  "timerOverhead": {
    "crossPlusOneSeconds": 0.23,
    "pllSeconds": 0.394,
    "fits": [
      {
        "window": "cross+1",
        "n": 3059,
        "intercept": 0.374,
        "interceptStdError": 0.025,
        "secondsPerTurn": 0.0888,
        "clean": false
      },
      {
        "window": "pairs2-3",
        "n": 3051,
        "intercept": 0.304,
        "interceptStdError": 0.029,
        "secondsPerTurn": 0.0766,
        "clean": true
      },
      {
        "window": "pair4",
        "n": 3053,
        "intercept": 0.116,
        "interceptStdError": 0.012,
        "secondsPerTurn": 0.0715,
        "clean": true
      },
      {
        "window": "oll",
        "n": 2969,
        "intercept": 0.011,
        "interceptStdError": 0.019,
        "secondsPerTurn": 0.0967,
        "clean": true
      },
      {
        "window": "pll",
        "n": 2688,
        "intercept": 0.537,
        "interceptStdError": 0.021,
        "secondsPerTurn": 0.0559,
        "clean": false
      }
    ]
  }
};
