# @cubing-companion/solver

Cross, xcross and F2L-insertion candidate enumerators. Everything before this describes what a
solve *was*; this answers what could have been done instead.

Depends on `engine` and on `analysis` for cross geometry, and on nothing that knows where a
position came from — a guard test enforces it.

```ts
const { candidates, optimal } = enumerateCross(state, Face.D, { maxExtra: 1 });
//    12 optimal solutions, plus ~200 one move longer

const xcross = enumerateXcross(state, Face.D, slot, { maxSolutions: 10 });

// Which pair next, and what does each cost? Cheapest first.
for (const { slot, result } of enumerateNextPair(state, Face.D)) {
  console.log(slotName(slot), result.optimal, result.candidates[0]!.moves);
}
```

## An enumerator, not a solver

One optimal answer is nearly useless for what B2 exists to feed. A5 compares what you did
against what you could have done, which needs alternatives; B3 trains on "the pro's choice,
plus the ones they passed over", which needs the set. So every entry point returns ranked
`Candidate`s, and `maxExtra` widens the net beyond the optimum — the shortest cross is very
often not the one a person would find.

## The cross needs no search

Four edges across twelve slots with two orientations is `12P4 × 2⁴ = 190,080` positions. A
breadth-first sweep from solved gives the **exact** optimal distance for every one, and
solutions come from walking down the table. `PLAN.md` called for IDA* with pruning tables; for
the cross the table simply is the answer.

Two properties the tests pin against outside knowledge, which is unusual and worth using:
190,080 reachable positions, and a hardest case of **8 moves** — the published God's number for
the cross in HTM. Agreeing with both checks the engine's move tables, the packing and the
transition all at once.

The table also serves as an admissible heuristic for xcross, where search is genuinely needed:
a finished xcross has a finished cross, so a position six moves from a cross is at least six
from an xcross. That is what lets the xcross search claim to find *all* solutions at a length
rather than merely some — which matters, because a ranking model trained on an incomplete
candidate set learns from negatives that were never really alternatives.

## Only face turns, and why that is not a limitation

The search uses the 18 HTM face turns. Wide moves are excluded, and this was measured rather
than assumed: adding all six wide families gives a shorter cross for **0 of the 190,080
positions**, with a byte-identical depth histogram. `Rw` is `L` composed with an `x` rotation,
and a cross is rotation-invariant, so every wide move duplicates a face turn already present —
at double the branching factor, compounding at every ply.

The corpus agrees, from the other direction: **42% of real crosses use a wide move, and not one
of them beats the HTM optimum.**

Slice moves are different, and this is the one place the metric genuinely diverges. `M2` is one
turn to a human but two in HTM, so a cross built with a slice can legitimately come out shorter
than the "optimum". Only 1.5% of real crosses use one; `respell.ts` handles wide spellings for
presentation, and slices remain out of scope.

## Validated against 7,725 real crosses

`npm run corpus-check -w @cubing-companion/solver` runs the solver over B1's corpus. The claim
is falsifiable in one line — **no human cross can be shorter than the computed optimum** — and
a single counter-example would mean the solver is wrong.

**Zero violations.** (Seventeen appear before excluding slice-move crosses; all seventeen are
the metric mismatch above, none a solver error.)

The by-product is the first genuinely interesting output of this track:

| how far from optimal | share |
|---|---|
| optimal | **31.4%** |
| +1 | 25.7% |
| +2 | 17.6% |
| +3 or worse | 25.3% |

Mean excess **1.95 moves**, and **1.83 rotations** per cross — a cost the HTM count does not
charge for, and one A3 should, since a rotation is real time.

That the world's best find the optimal cross under a third of the time is exactly why A5 is
worth building: there is real room between what people do and what was available.

## Inserting a pair is a different search

A cross or xcross search only has to *reach* something. An F2L insertion has to reach it without
losing what is already there: the cross intact, the new pair in, and **every pair built before it
still built**. It may break all of them along the way — every real F2L algorithm does — but only
the position it lands on is judged.

That also removes the pruning the other two searches lean on. Once the cross is solved its
distance is zero, so the cross table prunes nothing at the root.

The heuristic is a **maximum of admissible lower bounds**: cross distance, plus a pair distance
for the target and for each pair that has to survive. A pair table is a corner across 8 slots in
3 orientations with an edge across 12 in 2 — **576 positions, all reachable, hardest case 6
moves**, built in under a millisecond. Ignoring the rest of the cube is exactly what makes it a
lower bound: bringing a pair home with a free hand cannot cost more than bringing it home while
protecting a cross. Each term is a genuine lower bound, so their maximum is admissible, and the
search still finds *all* solutions at a given length rather than merely some.

The cross term stops being useless the moment the search breaks the cross — which is precisely
when pruning is needed.

`preserve` defaults to whatever is already solved in the position given. Detecting it beats
demanding it: the position already knows what has been built, and asking a caller to repeat it
is a pointless opportunity to get it wrong.

## Validated against 1,482 real pair insertions

Same falsifiable claim as the cross, one level deeper: **a pro's own pair insertion cannot be
shorter than the computed optimum for the position they were actually in.** **Zero violations.**

| how far from optimal | share |
|---|---|
| optimal | **27.4%** |
| +1 | 28.8% |
| +2 | 25.5% |
| +3 or worse | 18.3% |

Mean excess **1.59 moves** — so pros leave slightly less on the table per pair than per cross
(1.95), but there are four pairs and one cross.

Worth naming what the optimum is here: **6.5 moves on average**, against the 7–11 usually quoted
for F2L. The quoted figure is for *algorithmic* F2L — recognise the case, execute the known
sequence. The gap between the two is the thing A5 exists to show and B3 to learn.

### Pseudoslots, and why they are set aside

Three insertions did come out shorter than "optimal" before the check was right, and they are
worth recording because they are a real technique rather than noise. `D R U R'` inserts a pair
against a cross that has been turned a quarter — correct as a block, not aligned to the centres —
and the realignment gets paid in the next pair or folded into it. The segmenter credits the pair,
because it aligns the cross before testing slots. The solver does not, because it was asked for a
position that is finished.

They are not the same goal, so the two lengths are not comparable, and those spans are set aside
rather than counted as a solver that came up short. It stays out of the enumerator for now on
frequency: **0.5% of spans**, 7 in 1,528. If A5 ever wants to suggest pseudoslotting, the goal
test grows to "solved up to a D offset" and the heuristic to a minimum over the four offsets.

Wide moves, by contrast, are left in the comparison — 10% of spans use one. `Lw` is `R` with an
`x` rotation and HTM counts rotations as free, so a wide move is fairly charged as the single
turn the human paid for. Slices are still excluded, for the reason above.

## Performance

`npm run bench -w @cubing-companion/solver`. All main-thread — A2 established that Turbopack
cannot instantiate a Web Worker for cubing.js at all, so anything needing one would be dead on
arrival here.

| | median | p90 | max |
|---|---|---|---|
| table build (once per colour) | 89 ms | | |
| cross, optimal only | <0.1 ms | 0.2 ms | 0.5 ms |
| cross, within +2 (840 candidates) | 2.1 ms | 2.4 ms | 2.8 ms |
| xcross, first solution | 15 ms | 57 ms | 104 ms |
| xcross, all optimal | 35 ms | 355 ms | 369 ms |
| pair table build (per slot) | 0.6 ms | | |
| first pair, all optimal | 1.1 ms | 7.4 ms | 10.2 ms |
| last pair, all optimal | 38 ms | 254 ms | **2.9 s** |
| all four slots costed | 30 ms | 191 ms | 231 ms |

Two things earn most of that. The table is built by transitioning packed integers rather than
applying moves to cube states, which took the build from 2s to 89ms. And the xcross search keeps
one mutable state, undoing each move on the way out, so a search visiting hundreds of thousands
of nodes allocates nothing.

The split matters for how the two are used: "first solution" is the interactive path a planner
needs, while "all optimal" is batch work generating B3's training candidates, where a
third-of-a-second tail is irrelevant.

Inverting the two piece permutations once per node, rather than scanning them for each pair the
node asks about, roughly halved the last-pair median — with four pairs to bound, the same two
arrays were being searched four times over.

**The last pair has a tail A4 has to plan around.** Unlike cross and xcross, "first solution"
buys nothing there (38.1 ms against 38.4 ms): with only ~3 solutions to collect, essentially all
the work is proving nothing shorter exists. The heuristic is capped at 6 by the pair table, so a
9-move insertion gets almost no pruning in its last plies, and the worst sample takes 2.9
seconds. A planner should bound it with `maxDepth` or accept that a rare position blocks for a
few seconds. The bench sample is seeded so that number is comparable run to run — with a
re-randomised sample a regression here is indistinguishable from an unlucky draw.

## Not here yet

Last-layer search, and ranking beyond move-count order — that is B3's job, not this package's.
Pseudoslot-tolerant insertion, as above, if it turns out to be worth the 0.5%.
