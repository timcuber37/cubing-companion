# B3 — learning to rank speedcubing decisions

Two models that predict what a world-class solver would do next, trained on 9,865 reconstructed
competition solves. Both beat the rule they replace.

`PLAN.md` set the bar in one line: *"the model must beat 'fewest moves wins' to matter."* It does,
by 10.9 points on solvers it has never seen.

```
python3 -m venv ml/.venv                          # Homebrew's Python is PEP 668 managed,
ml/.venv/bin/pip install -r ml/requirements.txt   # so a venv is not optional here

npm run build-dataset -w @cubing-companion/planner   # corpus -> data/decisions.jsonl, ~30 min
ml/.venv/bin/python ml/train.py                      # trains both heads, seconds
ml/.venv/bin/python ml/eval.py                       # the numbers below
ml/.venv/bin/python ml/export.py                     # ONNX -> apps/web/public/models/
```

The dataset step needs `data/corpus.jsonl`, which is not redistributed — rebuild it with
`npm run crawl` then `npm run build-corpus`, both in `@cubing-companion/corpus`. The exported
models are committed, so the app runs without any of this.

## The problem

A cube solver makes a handful of choices per solve that a search cannot make for them, because
every option is legal and several are optimal. Which cross to build. Which pair to insert next.
Searching tells you what is *possible*; it says nothing about what a good solver would *do*.

So each decision becomes a ranking problem: enumerate what the solver could have done, label what
they actually did, and learn the difference.

| head | decision | options | decisions |
|---|---|---|---|
| **pair** | which F2L slot to fill next | 2–4 | **15,607** |
| **cross** | which cross solution, held which way | 4–864 (median 12) | **1,541** |

## Getting labels out of a reconstruction

The pair head is easy: the segmenter already knows which slot each phase filled, so the label is
read straight off. Only three decisions per solve are real, because by the fourth pair there is
nothing left to choose.

The cross head is not easy, and this is the part worth reading.

A pro's cross is written in **their** frame, and freely uses wide moves, slices and rotations —
none of which the search emits. Comparing move sequences as text was never going to work. So
nothing compares text: each candidate is applied to the scrambled cube, and a candidate matches
when it **reaches the same position** the pro reached, up to orientation. Two different optimal
cross solutions leave the cube in different states, so agreeing on the position means agreeing on
the solution. Every notation problem evaporates because notation is never examined.

It worked almost perfectly:

| | of 5,449 crosses |
|---|---|
| matched to an enumerated candidate | 1,541 (28.3%) |
| the pro took a longer route than optimal | 3,159 (58.0%) |
| held the cross colour somewhere other than down | 739 (13.6%) |
| **optimal, but no candidate matched** | **10 (0.2%)** |

That last row is the one that mattered. Ten failures in 5,449 means the matching is sound and the
28.3% yield is a property of pros, not of the method — they simply build the optimal cross under a
third of the time.

**The cost of that is a biased training set**, and it should be stated plainly: the cross head
learns *which optimal cross a pro picks*, from the solves where they picked one. It has never seen
the 58% of crosses where a pro took a longer, presumably more comfortable route. It is the right
model for ranking a search's output — which is exactly what the planner asks it to do — and the
wrong model for predicting crosses in general.

## Features

Twelve per head, computed by `packages/planner/src/features.ts` — **the same TypeScript the
browser runs at inference.** Python never computes a feature. That is not tidiness: a feature
defined in two places is a model that can quietly disagree with itself, and the failure has no
symptom beyond being a bit worse than it should be.

The pair features were chosen from a measurement made before any model existed. Among decisions
where two slots tie on insertion length — where move count is guessing — the pro takes the slot
whose **corner is in the last layer** 89.9% of the time against 52.7% by chance. The edge, alone,
is noise. Move count already prices digging a corner out; it cannot price not being able to *see*
the pair.

## Results

Held out **by solver**, not by decision. The five most-represented solvers are 36% of the corpus,
so a random split would let the model learn "Max Park does this" and score well without having
learned anything transferable.

### Pair order — 15,607 decisions

| | chance | fewest moves | **model** |
|---|---|---|---|
| held out by solver | 35.8% | 58.7% | **69.5%** (+10.9) |
| random split | 36.0% | 55.1% | **67.5%** (+12.5) |
| **where move count ties** | 35.0% | 39.0% | **56.0%** (+17.0) |

top-3 is 99.2%, which says more about there being at most four options than about the model.

The tied row is the one to look at. That is the slice where the baseline has no information at
all, and the model converts a coin-flip into a decision — the +17 points there are most of where
the overall +10.9 comes from.

| | fewest moves | model |
|---|---|---|
| pair 1 | 64.4% | 69.6% |
| pair 2 | 51.8% | 65.8% |
| pair 3 | 59.5% | 73.2% |

**What it leans on** (accuracy lost when a feature is shuffled):

```
cornerOnTop          +0.219  ############################################
edgeOnTop            +0.036  #######
excessOverBest       +0.024  #####
insertionLength      +0.015  ###
logWays              +0.008  ##
...everything else   ≤0.006
```

One feature carries the model, and it is the one the pre-planning measurement predicted would.
That is a good sign for the measurement and a modest one for the model: most of what it knows
could be written as a two-line rule. What the model adds over that rule is knowing *when* to
override move count, which the ablation cannot show directly.

### Cross choice — 1,541 decisions

Here the baseline is not move count — every candidate is already optimal — but **A4's comfort
heuristic**, the unigram face-frequency model currently shipping in `packages/planner`. So this
number answers the question that matters: is a learned model better than the rule in the product?

| | chance | A4 comfort | **model** |
|---|---|---|---|
| held out by solver | 11.8% | 39.0% | **48.7%** (+9.6) |
| random split | 12.2% | 46.6% | **52.4%** (+5.7) |

top-3 is 72.0%, against a median of 12 options.

```
comfort              +0.116  #######################
turnsR               +0.101  ####################
turnsB               +0.095  ###################
halfTurns            +0.053  ###########
endsOnDown           +0.042  ########
```

The model's most important feature is the heuristic it replaces. It did not discard A4's model, it
refined it — adding that right-face turns are good beyond what their frequency suggests, that back
turns are worse, that half turns are cheap, and that a cross ending on a `D` alignment turn looks
like something a person would do.

### An unusual result worth flagging

For the pair head, the **solver-held-out split scores higher than the random split** (69.5% vs
67.5%). That is backwards from the usual expectation, where a grouped split is harder.

The benign reading is that there is no per-solver habit to memorise, so the harder split costs
nothing and the difference is which solvers happened to land in each bucket. The unflattering
reading is that the held-out solvers are simply more predictable than average. With 393 solvers
and a heavily skewed distribution, a single split cannot separate these. It is reported rather
than explained.

## Getting it into the browser

PyTorch → ONNX → ONNX Runtime Web, running inside the existing planner worker.

Whether that would work at all was checked first, because A2 had established that Turbopack cannot
instantiate cubing.js's WASM module worker and ONNX Runtime Web leans on the same machinery. It
runs. Two things were needed, both found by trying it rather than by reading documentation:

- **`external_data=False` on export.** By default torch writes the weights to a `.onnx.data`
  sidecar and the model only references it, which fails in a browser with `Module.MountedFiles is
  not available` — there is no filesystem to mount it from.
- **A dynamic first axis**, since a decision has two options or eight hundred.

Each model exports with a fixture of real held-out feature vectors and the scores PyTorch gave
them. `/selftest` re-scores that fixture **through the shipped loader** and reports the worst
disagreement:

```
pair:  PASS — 256 rows, worst difference 9.54e-7
cross: PASS — 256 rows, worst difference 9.54e-7
```

That test exists for one specific failure: if the feature order in `features.ts` ever drifts from
the order the weights were fitted to, nothing throws. The model just gets worse, and looks like a
model that was never very good.

Inference stays off the main thread — the page paints a full 60fps while the model loads and
scores.

## What these models are not

- **Imitation, not optimisation.** They predict what a fast human did, which is the entire premise
  of the project. Where pros are collectively wrong, these models are confidently wrong with them.
- **Bags of features.** Neither knows anything about move *order*. For the cross head that is a
  real limitation: a solution and its reverse have identical features and identical scores, which
  is obviously wrong. Move order is where regrips and finger tricks live.
- **Small.** 12 → 16 → 8 → 1, a few hundred parameters, seconds to train. That is a deliberate
  match to 15,607 decisions, not an aspiration to something larger.
- **Blind to one feature at inference.** `adjacentToPrevious` needs to know which slot was filled
  last, which cannot be recovered from a static position. Its importance is +0.002, so this is a
  documented wart rather than a defect — and because it is then constant across every option in a
  decision, it mostly cancels in the softmax.

`PLAN.md` B4's token encoder is the answer to the second point, if the corpus ever grows enough to
support one.
