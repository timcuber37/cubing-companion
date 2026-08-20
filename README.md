# Cubing Companion

An app built on a virtual cube synced to a physical smart cube, that analyzes your solves,
scores them against how the world's best actually solve, and shows you what a top solver
would have done from your exact position.

The ML core is imitation learning of expert human solving style from solve
reconstructions — not an optimal solver. Classical solvers own optimality; the interesting
question is what a *fast human* does from a given position, and why.

See [PLAN.md](PLAN.md) for the full roadmap.

## Status

**A0 — cube engine foundation: done.** Everything else is ahead.

| Track | Status |
|---|---|
| A0 — cube engine | shipped — [`packages/engine`](packages/engine) |
| B1 — pro reconstruction corpus | shipped — [`packages/corpus`](packages/corpus), 9,865 verified CFOP solves |
| A1 — smart cube link (GAN) | not started |
| A2 — solve capture + phase segmentation | not started |
| A3 — analysis + scoring | not started |
| B2 — search baselines | not started |
| B3 — ranking model | not started |

B1 landed ahead of A2 rather than after it. The reconstructions carry the reconstructor's
own `// phase` annotations, so the corpus can be segmented from human labels instead of
waiting on a segmenter — which also leaves A2 a labelled ground-truth set to be validated
against.

## Layout

```
packages/engine/   3x3x3 state, moves, notation — the dependency root
packages/corpus/   reco.nz reconstruction corpus: fetch, verify, segment, summarize
apps/web/          Next.js app (A1+) — placeholder
ml/                PyTorch training (B3) — placeholder, outside the npm workspaces
data/              corpus cache and derived output — gitignored, reproducible
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
```

## Credits

Reconstruction data comes from [reco.nz](https://reco.nz), a volunteer community project
with no ads and no sponsorship. Their data is not redistributed here — the corpus is built
locally from a cached, rate-limited crawl, and only code and summary statistics are
committed. Engine test fixtures credit their solver and reconstructor individually.
