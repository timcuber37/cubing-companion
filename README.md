# Cubing Companion

An app built on a virtual cube synced to a physical smart cube, that analyzes your solves,
scores them against how the world's best actually solve, and shows you what a top solver
would have done from your exact position.

The ML core is imitation learning of expert human solving style from solve
reconstructions — not an optimal solver. Classical solvers own optimality; the interesting
question is what a *fast human* does from a given position, and why.

See [PLAN.md](PLAN.md) for the full roadmap.

## Status

**A4 shipped — the planner.** Scramble, solve, and get the solve back broken into phases,
replayable at the tempo you actually turned and scored against world-class solves — and now,
before you start, which cross to build and how to hold the cube to build it. A0–A4, B1 and B2
are done.

Two findings drive the whole product. From the solver: across 7,725 corpus crosses the world's
best build the **optimal cross only 31% of the time**, and across 1,482 pair insertions they hit
the **optimal insertion 27% of the time** — averaging 1.95 and 1.59 moves more than necessary.
That gap is what A5 exists to show you.

From the corpus timings: between 2013–16 and 2024+ median solve times fell **36%** while median
move counts fell **9%**. Cubers got dramatically faster at turning and only slightly better at
planning — which is why move-count percentiles are scored across every era and time percentiles
only against 2021 onwards.

And from the cross moves themselves: pros turn the back face on just **2.5%** of cross moves,
because they spend inspection choosing how to hold the cube rather than rotating mid-solve
(1.45 rotations in inspection against 0.23 during the cross). Picking the frame for you is most
of what the planner does.

| Track | Status |
|---|---|
| A0 — cube engine | shipped — [`packages/engine`](packages/engine) |
| B1 — pro reconstruction corpus | shipped — [`packages/corpus`](packages/corpus), 9,865 verified CFOP solves |
| A1 — smart cube link (GAN) | shipped — [`packages/cube-link`](packages/cube-link) + [`apps/web`](apps/web) |
| A2 — capture + phase segmentation | shipped — [`packages/analysis`](packages/analysis) + [`packages/session`](packages/session) |
| A3 — analysis + scoring | shipped — [`packages/metrics`](packages/metrics) + solve replay in [`apps/web`](apps/web) |
| B2 — search baselines | shipped — [`packages/solver`](packages/solver), cross + xcross + F2L insertion |
| A4 — cross+1 / xcross planner | shipped — [`packages/planner`](packages/planner) + planner panel in [`apps/web`](apps/web) |
| A5 — "what would a pro do" diff | not started |
| B3 — ranking model | not started |

B1 landed ahead of A2 rather than after it. The reconstructions carry the reconstructor's
own `// phase` annotations, so the corpus can be segmented from human labels instead of
waiting on a segmenter — which also leaves A2 a labelled ground-truth set to be validated
against.

## Layout

```
packages/engine/     3x3x3 state, moves, notation, facelets — the dependency root
packages/corpus/     reco.nz reconstruction corpus: fetch, verify, segment, summarize
packages/cube-link/  cube input adapters: smart cube, manual entry, replay
packages/analysis/   CFOP phase segmentation from cube state
packages/session/    solve capture and local-first storage
packages/solver/     cross, xcross and F2L-insertion candidate enumerators
packages/metrics/    per-phase metrics and percentile scoring against the corpus
packages/planner/    ranks candidates into advice: which cross, and how to hold the cube
apps/web/            the app — connect a cube, scramble, solve, review
ml/                  PyTorch training (B3) — placeholder, outside the npm workspaces
data/                corpus cache and derived output — gitignored, reproducible
```

The workspace boundary is load-bearing: analysis code must never import the smart cube
adapter. The smart cube is one input among several — pasted reconstructions and file
imports feed the same pipeline — which is also what keeps everything testable in CI
without hardware.

## Getting started

```sh
npm install
npm test        # full suite, no hardware or network needed
npm run typecheck
npm run dev     # the A1 harness at localhost:3000
```

Smart cube connection needs Web Bluetooth — Chrome or Edge on desktop, Chrome on Android.
Manual input works in any browser, which is what keeps the rest of the plan testable
without hardware.

## Credits

Reconstruction data comes from [reco.nz](https://reco.nz), a volunteer community project
with no ads and no sponsorship. Their data is not redistributed here — the corpus is built
locally from a cached, rate-limited crawl, and only code and summary statistics are
committed. Engine test fixtures credit their solver and reconstructor individually.
