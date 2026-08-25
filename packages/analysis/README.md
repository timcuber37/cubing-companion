# @cubing-companion/analysis

CFOP phase segmentation from cube state. Takes a scramble and a move list, returns where the
cross, each F2L pair, OLL, PLL and AUF began and ended.

Depends on `@cubing-companion/engine` and nothing else. It must never import `cube-link`:
analysis works on moves and states and cannot be allowed to care whether they arrived from a
smart cube, a pasted reconstruction, or a file.

```ts
const { segmentation } = segmentSolve(parseMoves(scramble), parseMoves(solution));
for (const span of segmentation.spans) {
  console.log(span.phase, span.turns, span.rotations, span.slot);
}
```

## Accuracy

Scored against the 5,475 cleanly-labelled solves in B1's corpus, whose reconstructors wrote
their own phase annotations:

| phase | n | exact | convention | differs | agree |
|---|---|---|---|---|---|
| cross | 5474 | 4413 | 959 | 102 | **98.1%** |
| f2l1 | 5474 | 3399 | 1789 | 286 | 94.8% |
| f2l2 | 5474 | 3275 | 1943 | 256 | 95.3% |
| f2l3 | 5474 | 3476 | 1735 | 263 | 95.2% |
| f2l4 | 5474 | 5306 | 98 | 70 | 98.7% |
| oll | 4877 | 4503 | 289 | 85 | 98.3% |
| pll | 4579 | 1775 | 2804 | 0 | **100%** |

**Overall 97.12%.** Reproduce with `npm run evaluate -w @cubing-companion/analysis`.

*Convention* means the phase's own completion predicate holds at **both** boundaries — the
moves between them did not change whether it was done, so neither placement is wrong. That
covers a reconstructor attaching a trailing rotation to the phase it follows, and folding the
final AUF into PLL rather than labelling it separately (which is why PLL has so many).

A caveat on the sample: agreement is measured on `clean` solves only, since a `merged` solve
writes several phases as one block and has no per-phase boundary to compare against. That
excludes every xcross solve *by construction*, because an xcross is a merged label. The
descriptive statistics are gathered over all 9,865.

Independent corroboration for the parts labels cannot check: the segmenter puts the xcross
rate at **37.4%**, against **35.8%** from B1's completely separate label-based count.

## How it works, and why in that order

**Normalise orientation first.** `normalizeOrientation` rotates the centres home, so a piece
is solved exactly when `cp[i] === i && co[i] === 0` — a condition that does not care which
face the cross is on. Colour neutrality then costs nothing: the predicates just need telling
*which* pieces to look at, which `geometry.ts` derives from the engine's piece names.

A pleasant consequence: in the normalised frame a face's index *is* its colour, so cross
colour needs no separate bookkeeping.

**Find the cross colour from F2L completion, not from the cross.** Looking for a cross first
is ambiguous — several faces' crosses are incidentally complete at various points in a solve.
"Exactly one face's layer is left unsolved" happens once and means one thing, so the face
that reaches it earliest *is* the cross colour.

**Never scan backwards from the solved state.** Last-layer algorithms transiently break the
cross with their wide moves and slices, so a backward scan stops inside OLL. An early attempt
that did this scored **0%** against the labels.

**Ask about OLL in facelets, not orientation.** `co`/`eo` are defined about the U/D axis and
mean nothing useful for a cross on L. "The last layer face shows one colour" is what OLL means
anyway, and it holds for any cross.

### Three things that were nearly right

Recorded because each was measured, not reasoned, and each cost real accuracy:

**Rotating the cross onto D does not work.** The obvious simplification — turn every solve
into a textbook D-cross solve so fixed slot predicates can be reused — is self-defeating.
Rotating moves the centres off home, destroying the "slot index equals piece index" property
those predicates depend on. It identified every solve as a D-cross.

**The offset allowance must not be unconditional.** Most solvers build the cross without
regard to alignment and square it with a final turn of the cross layer. Treating the cross as
finished the moment it is *built* ends the phase a move early on all of them: cross agreement
fell from 97.8% to 45.8%. It is only pseudoslotting if a pair went in *while the cross was
still offset*, and that is the condition used.

**An xcross is a block, not an instant.** Defining it as "cross and first pair finished on the
same move" undercounts roughly threefold against how the corpus labels them, because within an
xcross block the cross is usually left a turn out of place and squared up as the pair goes in.
`freePairs` is therefore measured at the alignment point.

## Edge cases

| Case | Handling |
|---|---|
| Pseudoslotting | The cross counts as built up to a turn of its own layer; `crossOffsetAtEnd` records how far out it was |
| xcross / xxcross | `freePairs` counts pairs already standing when the cross is squared up |
| Keyhole, out-of-order pairs | Slots are tracked independently, so solve order is an output rather than an assumption |
| OLL / PLL skips | Zero-*turn* spans, not empty ones — under the rotation convention a skipped OLL can still absorb the rotation before it |
| Solves ending rotated | Verified with `isSolvedIgnoringOrientation` |

## What it does not do

No timing. Reconstructions carry no per-move timestamps, and phase *durations* are A3's
problem — this package only says which moves belong to which phase. Smart-cube solves reach it
with timestamps attached from `cube-link`, and those pass straight through.
