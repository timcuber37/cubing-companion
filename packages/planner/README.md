# @cubing-companion/planner

Turns search results into advice. `solver` says what solves a position; this says which of those
you should actually do, and how to hold the cube while you do it.

```ts
const plans = planColours(state, [Face.D, Face.U], { keep: 3 });
//    yellow cross, 5 moves: hold green in front, then F R' D2 F R2
```

## Holding the cube is the decision that matters

The obvious thing for a planner to do is rank by move count and stop. That leaves most of the
value on the table, and the corpus says so plainly.

Across 5,475 clean corpus solves, rotations split **1.45 during inspection** — 95% of solves have
at least one — against **0.23 inside the cross itself**. Pros are not rotating their way through a
cross. They look at the scramble, decide how to hold it, and then execute in that frame almost
without rotating.

You can see the consequence in which faces they turn. Of the 16,834 turns in crosses built purely
from outer face moves:

| D | R | F | U | L | **B** |
|---|---|---|---|---|---|
| 29.3% | 29.2% | 16.5% | 12.7% | 9.9% | **2.5%** |

The back face is turned **twelve times less often than the right**. Not because pros pick
B-free solutions, but because they hold the cube so the work isn't at the back.

So this package does the same thing. A cross pins its colour to the bottom and leaves four frames
free; every candidate is scored in all four and shown in the best one. Measured over 809 optimal
crosses that takes mean back-face turns from **1.19 to 0.39**, and takes "there is a back-free
optimal cross" from 52% of scrambles to **90%**.

## Ranking: length first, then a model

Ranking is **length first, learned model second**. The second half breaks ties; it can never
promote a longer solution. A planner that talks you into a seven-move cross because it reads
nicely is worse than one that says nothing.

B3 now supplies that second half. Its cross head beats the comfort model below by **9.6 points**
on unseen solvers (48.7% against 39.0%), and it picks the grip as well as the ordering, so where
the model loads it takes over both. Where it does not, comfort still decides and the planner
degrades to what A4 shipped rather than to nothing.

`rankNextPair` answers a question A4 could not ask at all — *which pair next* — at **69.5%**
against a 58.7% movecount baseline. See [`ml/README.md`](../../ml/README.md).

## The comfort model, and what it is worth

Comfort itself is the mean log-share of a solution's moves under the frequencies above — a
unigram model of pro cross turns, fitted rather than invented.

Checking it against those same frequencies would be circular, so the real test is whether it
picks the frame a pro *actually held the cube in*, which the aggregate fit says nothing about.
Fitted on 10,857 pre-2022 turns and scored with those weights alone on the 946 crosses from 2022
onwards:

> **the pro's own frame comes top of the four 79.4% of the time — 76.1% outright, with no tie —
> against a 25% chance baseline.**

**What it does not know** is move order, which is where most real ergonomics lives: regrips,
whether two turns form a comfortable trigger, whether your hands finish in position for the first
pair. A solution and its reverse score identically, which is plainly wrong.

It is no longer the last word — B3's cross model outranks it — but it is still the fallback when
the model cannot be fetched, and it remains the model's single most important feature, which is a
better outcome for it than being replaced outright.

## The renaming table is derived, never written

Expressing a solution in a different frame means renaming its faces, and the table for that is
easy to get backwards. `solver`'s `respell.ts` shipped with every rotation inverted: every single
output produced a different cube position, and no test noticed, because none of them asked
whether the cube ended up where it should.

So `orientation.ts` derives all 24 frames by breadth-first search over `x`, `y`, `z`, and finds
each renaming by asking the engine which face turn reaches the same state. The property test is
the one that would have caught the old bug:

> rotate the cube, turn the renamed moves, and you must land exactly where turning the original
> moves and then rotating would have put you.

That is checked over random states and sequences, for all 24 frames, plus the end-to-end version:
hold the cube as the plan says, turn what it gives you, and the cross is solved.

## Colours

`engine` has no notion of colour — a `Face` is a slot in space — which is right there and useless
here, because nobody orients a cube by thinking "rotate x y'". `colours.ts` names the WCA-standard
scheme (white up, green front, red right). A differently stickered cube would be *named* wrongly;
nothing would compute wrongly, since every calculation runs on indices.

## Telling you what you missed

A5's diff asks the same question backwards: not "what should I do" but "at the moments that
mattered, what would a top solver have done instead, and why".

`decisions.ts` is the single definition of what a decision point *is*, shared between the dataset
builder that trained the model and the diff that queries it. Two copies of that would let A5 score
inputs subtly unlike the ones the model learned from — and nothing would fail, the advice would
just get quietly worse. Same rule as `features.ts`, same reason.

`explain.ts` does the "show why" half, and the interpretable part is the harder one. Listing which
feature values differ is easy and useless: two pairs usually differ in most of their features, and
only one or two of those differences moved anything. So the attribution is **counterfactual** —
give your option one of the model's feature values, re-score, and see how much of the gap closes:

> *A top solver would more often take **FR** (53%, against 1% for what you did).*
> — FR's corner was already up top where you can see it, while FL's was buried in a slot

Both of those pairs go in in six moves. Nothing about move count separates them, which is why the
diff has something to say that A3's scoring cannot: A3 rates that solve **95 for efficiency** while
the diff matches **none** of its three pair choices.

One trap worth recording, since it looks like a reasonable thing to do: rank the attributions by
raw score delta **per decision**, never by averaging each feature's share across many. A single
swap can overshoot the gap, and the average then crowns `backTurns`, whose actual permutation
importance is ~0.005.

## Features for the models

`features.ts` is the one definition of what the B3 models see, shared between the dataset builder
and the browser. Nothing in `ml/` computes a feature. A feature defined twice is a model that can
disagree with itself, with no symptom beyond being slightly worse than it should be.

## Cost

A full colour-neutral sweep — cross and all four xcrosses, six colours — runs a median of **1.9 s**
and a worst case over **5 s**. That belongs off the main thread, and `apps/web/workers/` puts it
there. Results are posted per colour rather than batched, so the first cross lands in about 150 ms.

Web Workers needed checking, because A2 concluded they were unusable under Turbopack. That was
cubing.js's WASM *module* worker; a plain worker built from our own TypeScript is fine, verified
in a browser before the panel was written. During a live sweep the page still paints at a full
60 fps.
