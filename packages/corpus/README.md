# @cubing-companion/corpus

The pro reconstruction corpus: fetch, parse, verify, segment, and summarize solves from
[reco.nz](https://reco.nz). Produces the distributions A3 scores user solves against.

## Pipeline

```
crawl          reco.nz  ->  data/raw/{id}.html      (network, cached, never refetched)
build-corpus   raw HTML ->  data/corpus.jsonl       (local only)
                        ->  data/rejections.jsonl
                        ->  data/summary.json
report         summary  ->  stdout
```

The stages are separate so that a parser or normalization change never triggers a refetch.
That is the main reason the raw cache exists.

```sh
npm run crawl -w @cubing-companion/corpus -- --from 1 --to 500
npm run build-corpus -w @cubing-companion/corpus
npm run report -w @cubing-companion/corpus
```

`crawl` is resumable — re-running skips anything already cached, so an interrupted crawl
just continues.

## Data policy

Everything under `data/` is gitignored. reco.nz's data is not redistributed; only the code
and the summary statistics are committed, and anyone can rebuild the corpus from scratch.

reco.nz is a volunteer project with no ads, no sponsorship, and **no contact channel** —
the listed dev team is four cats. There is no robots.txt and no stated terms, so nothing
prohibits this, but there is also nobody to ask. Politeness is therefore demonstrated by
behaviour: one request at a time, ~0.6 req/s, every response cached so the site is hit
once per solve ever, 404s cached too, and a hard abort on repeated failures.

## What the data is actually like

Findings that shaped the code, and that matter downstream:

**Phase labels are freehand and wide.** A first sample of 20 solves produced 28 distinct
labels — `xcross`, `Xcross`, `pseudo xcross`, `OLL(CP)`, `3rd/4th pairs`,
`2nd pair/finish cross`. `labels.ts` normalizes them, and reports anything it does not
recognize rather than dropping it, because a silently discarded label biases the
distributions in a way nothing downstream can detect.

**Not every solve is CFOP.** Roux (`FB`, `SS`, `CMLL`, `EOLR`), ZZ, and Petrus solves share
the corpus. A single method marker settles the classification; the scope guard in `PLAN.md`
is enforced at build time.

**Events share one id space.** 3x3, OH, and big-cube solves are interleaved, so the event
filter comes from the page title, not the id range.

**36% of solves start with an xcross, and over half of the 2024+ ones do.** This is the
important one. A standalone `cross` distribution can only be built from solves where cross
and first pair were annotated separately — that is, solves where the solver did *not* get
a free pair. Those are the harder crosses, so scoring a user against that baseline would
flatter them. Hence `groups` in `stats.ts`: `cross+1` is well defined either way, and
covers 9,042 solves against 5,475 for a standalone cross. reco.nz's FAQ says it treats
cross+1 as its unit for exactly this reason.

**Timing comes only from the published stats table.** Reconstructions carry no per-move
timestamps, so phase durations cannot be derived from moves. The table is the sole source,
at a coarser granularity (Total, F2L, LL, Cross+1, OLS, PLL) than the move annotations.
Every accepted solve publishes a total; **73.4% (7,239) also publish per-phase times**.

**Published timings are stackmat-timed.** reco.nz removed its smartcube reconstructions
because "smartcube times differ too heavily from keyboard/stackmat solve times". Move
counts transfer to a smart-cube user unchanged; TPS and durations carry a systematic bias
and should not be presented as a like-for-like percentile in A3.

**Some permalinks are double-encoded.** A trailing newline arrives as `%250A`. Values are
decoded up to twice; anything still malformed is left alone so it fails loudly in the
rejections file rather than being quietly patched into a different valid scramble.

## The corpus

Full sweep of ids 1–14,100 (14,097 fetched; 1,010 are 404 gaps, most of them a large
block in 13,000–13,999):

| Stage | Count |
|---|---|
| pages fetched | 13,087 |
| rejected — not 3x3 | 2,360 (OH 1,650 · 4x4 356 · SQ1 190 · 5x5 113 · 6x6 36 · 7x7 15) |
| rejected — not CFOP | 550 (Roux 514 · Petrus 27 · ZZ 6 · other 3) |
| rejected — does not solve | 164 |
| rejected — no reconstruction on the page | 125 |
| rejected — unparseable notation | 16 |
| rejected — no move lines | 7 |
| **accepted** | **9,865** (5,475 clean · 4,337 merged · 53 partial) |

Every accepted solve verifies against the engine. A 267-solve random sample re-verified
from raw text, independently of the pipeline, with zero failures.

The 164 `does-not-solve` rejections (1.7%) are genuinely broken community
reconstructions — one is annotated `// missed PLL` and ends in a long recovery sequence.
That is the engine-verification filter from `PLAN.md` doing its job.

The 16 unparseable are almost all two moves written without a space (`DU`, `FB'`, `yx`,
`Rr'`). They are individually repairable, but at 0.1% of the corpus the machinery is not
worth the risk, so they are left as a documented loss.

**OH is excluded by the scope guard, at a cost of 1,650 solves.** Those are genuine 3x3
CFOP reconstructions and would be valid for move-count analysis, so if the scope guard is
ever relaxed they are the single largest source of extra data.

## The corpus is not one population

Solve times nearly halve across the corpus's span, and technique shifts with them:

| Era | n | median time | median turns | xcross rate |
|---|---|---|---|---|
| 2013–16 | 1,797 | 8.81s | 58 | 16.5% |
| 2017–20 | 1,526 | 6.49s | 58 | 28.5% |
| 2021–23 | 4,401 | 5.66s | 57 | 38.5% |
| 2024+ | 2,141 | 4.90s | 53 | 51.8% |

**This matters for A3.** Scoring a user against the whole corpus compares them to a blend
of 2013 and 2026 solving. Note also that move count barely moves (58 → 53) while time
drops 44% — the modern speedup is mostly turning speed and lookahead, not efficiency. So a
movecount percentile ages well and a time or TPS percentile does not. A3 should either
restrict the baseline to recent years, weight by recency, or expose era as a dimension.

Solve id correlates strongly with date (ids 1–500 are all 2013; ids 11,001+ are 2024–26),
so **any id-range subsample is an era subsample**. An early-ids pilot understates the
xcross rate and overstates solve times.

## Segmentation, and its payoff for A2

Segmentation uses the reconstructor's own `// label` annotations rather than state
predicates. That means B1 does not depend on the A2 segmenter — and it produces a
**human-labelled ground-truth set** that A2 can be validated against later, which is a far
better position than having the segmenter be its own judge.

Solves are graded:

| Quality | Meaning | Use |
|---|---|---|
| `clean` | every CFOP phase appears exactly once, unmerged | per-phase distributions |
| `merged` | at least one block spans several phases (`xcross`, `3rd/4th pairs`) | group and whole-solve stats |
| `partial` | phases missing or unrecognized | whole-solve stats only |

Every accepted solve is verified through the engine: scramble + solution applied to a
solved cube must return to solved, allowing for whole-cube rotation.
