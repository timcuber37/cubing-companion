# @cubing-companion/metrics

Per-phase solve metrics, and percentile scoring against the pro corpus. `analysis` says what a
solve *was* and `solver` says what could have been done instead; this says whether it was any
good.

Pure: it takes spans and timestamps rather than a stored record, so it depends on `engine` and
`analysis` and nothing that knows about storage or the network.

```ts
const metrics = computeMetrics(spans, moveTimestamps);
const score = scoreSolve(metrics);
//    4.5 / 10, from efficiency 7.0, rotations 2.5, speed 4.1
```

## Three kinds of number, and they are not interchangeable

The corpus can judge some things exactly, some things approximately, and some things not at all.
Presenting all three as one score would be the easiest way to make this package dishonest, so
they are kept apart at the type level and in the UI.

| | baseline | scored? |
|---|---|---|
| turns, rotations | 4,478 clean solves, every era | percentile |
| times, TPS | 3,114 clean solves, 2021+ | percentile, two windows corrected |
| pauses, fluidity, recognition | **none, and never will be** | measured, banded |

Reconstructions carry no per-move timestamps. So the pause, fluidity and recognition metrics
`PLAN.md` asks for can be *measured* from a smart cube — precisely, they are the one thing we
have that the corpus does not — but they can never be given a percentile. They stay out of the
composite rather than being folded in with an invented weight.

## Times drift; move counts don't

Median totals fell **7.61s → 4.88s** from 2013–16 to 2024+, a 36% drop. Over the same span the
median move count fell 58 → 53, or 9%. Cubers got dramatically faster at turning and only
slightly better at planning.

So time baselines are scoped to **2021 onwards** and move-count baselines use everything. That is
not a free choice — scoring a 2026 solve against 2013 times would flatter it by about a third —
and it costs nothing, because 88% of the timed corpus is 2021 or later anyway.

## The corpus can only time some phases

reco.nz publishes `Total`, `F2L`, `LL`, `Cross+1`, `OLS` and `PLL`. Those windows overlap rather
than partition, but they decompose — and the decomposition is **asserted against our own
segmenter** rather than assumed, because every time baseline depends on it:

- `Cross+1 == cross + pair 1` — exact on **4,475 of 4,475** clean solves
- `OLS == pair 4 + OLL` — exact on **4,474 of 4,475**

That yields times for cross+1, pairs 2–3 as a block, pair 4, OLL and PLL. **Cross alone, and
pairs 1, 2 and 3 individually, are not recoverable.** The app measures them precisely; the corpus
simply never recorded them, so they are shown without a percentile. If the published windows ever
change meaning, `npm run generate` fails rather than silently shifting every score in the app.

## The timer correction

A stackmat starts when the hands leave the pad and stops when they touch it, and a reconstructor
allocates that dead time into the first and last phases. Our clock runs from the first move to
the last. Without a correction every user would look faster than they are, on exactly the two
windows that touch the timer.

Estimated by fitting `seconds = intercept + slope · turns` per window, on the middle 98% by
duration, and reading the dead time off as the gap from the windows that don't touch the timer:

| window | n | intercept | ±se | s/turn | |
|---|---|---|---|---|---|
| cross+1 | 3,059 | 0.374 | 0.025 | 0.089 | ← the grab |
| pairs2-3 | 3,051 | 0.304 | 0.029 | 0.077 | |
| pair4 | 3,053 | 0.116 | 0.012 | 0.072 | |
| oll | 2,969 | 0.011 | 0.019 | 0.097 | |
| pll | 2,688 | 0.537 | 0.021 | 0.056 | ← the drop |

Clean-window mean 0.143s, giving **0.23s for the grab** and **0.39s for the drop** — about 0.62s
per solve in total, which is the right order for the difference between cube time and stackmat
time.

**It is an estimate, and the standard errors understate the uncertainty.** Per-move rates
genuinely differ between phases (0.056–0.097 s/turn), so "same rate everywhere" is false, and an
intercept is an extrapolation to zero moves far outside the data. Trimming matters more than it
should: leaving the outliers in moves the PLL figure by 0.09s, a quarter of the quantity being
estimated. What can be said is that both come out positive, both are physically plausible, and
the two windows that touch the timer are the two that fit high.

So: the constants are re-derived by the generator on every run rather than typed in; the
correction is applied to the **pro baseline** rather than the user's measurement; and anything
scored against a corrected window is flagged (`overheadCorrected`, shown as ✽) so it is never
mistaken for a clean comparison.

## Pauses

The one definition with nothing to calibrate against. A pause is a gap of at least
**max(250 ms, 2.5 × the solve's own median gap)** — absolute *and* relative, because 400 ms is a
visible stall for a sub-8 solver and entirely normal for a 20-second one, and an absolute
threshold alone would tell a beginner they pause constantly and a fast solver that they never do.

Both constants are exported and adjustable, which matters more here than elsewhere: no amount of
corpus data can ever settle them.

Recognition is the gap before a phase's first move and execution is the rest, so
`recognition + execution === duration` exactly. Phase durations sum to the solve duration
exactly, too — a breakdown whose parts don't add up is one nobody believes.

## Regenerating

```
npm run generate -w @cubing-companion/metrics
```

Reads `data/corpus.jsonl` and writes `src/baselines.generated.ts`, which is **committed** —
following `engine`'s `tables.generated.ts`. The corpus itself is not redistributed, so a
contributor without it can still build and test, and the browser bundle needs no runtime fetch.

## Scoring

Every figure is a percentile — the share of pro solves you beat — and it is **shown out of ten**.
`Rated.score` keeps the 0–100 percentile, because that is the quantity the calibration tests pin;
`Rated.rating` is the same number on the scale people read.

The scale matters more than it looks. Out of a hundred, 50 reads as a bare pass; out of ten, 5.0
reads as the middle of the range, which is what it is — **5.0 is the median solve in a corpus of
world records**. For almost any user that is a very good day, and a number that looks like a
school grade would be actively discouraging about it.

Lower is better for every metric scored here, so the percentile is inverted: the 10th percentile
by move count is the 90th by score, or 9.0 out of 10.

The composite is the plain mean of its components and is never displayed without them. A number
that cannot be taken apart tells a solver they were a 4.5 and gives them nothing to do about it.
