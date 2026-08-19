# @cubing-companion/engine

3x3x3 cube state, moves, and notation. The dependency root of the project — analysis,
segmentation, and search all build on this. Nothing here knows about smart cubes, CFOP,
or the UI.

## Usage

```ts
import {
  parseMoves,
  stateAfter,
  isSolvedIgnoringOrientation,
  colorOnFace,
  Face,
} from "@cubing-companion/engine";

const moves = parseMoves("R U R' U' // sexy move");
const state = stateAfter(moves);

state.isSolved();                     // false
isSolvedIgnoringOrientation(state);   // false
colorOnFace(state, Face.U);           // Face.U — U centre unmoved
```

## Design notes

**State is flat typed arrays over one 46-byte buffer** (`cp | co | ep | eo | centers`),
sized for the IDA* search that B2 will run. `cp[i]` is the *piece* in *slot* `i`.

**Centres are tracked.** CFOP reconstructions contain rotations and wide moves, and
colour neutrality means the engine has to answer "which colour is on U *now*". An engine
without centre tracking cannot tell a white cross from a yellow one after a `y2`, and
would corrupt every downstream phase predicate. `colorOnFace` is the primitive that
makes colour-neutral detection possible.

**One code path for every move.** Face, wide, slice, and rotation families all resolve to
a precomputed transformation and compose identically. No special cases, so rotation
handling cannot drift out of sync with face turns.

**Move tables are generated, not hand-written.** `scripts/generate-tables.ts` derives them
from cubing.js's 3x3x3 KPuzzle, so they are correct by construction and our piece indexing
matches cubing.js's exactly — which makes the differential test a trivial comparison and
keeps the twisty player and solvers interoperable later. The runtime engine has no
cubing.js dependency in its hot path; only `notation.ts` and `scramble.ts` import it.

**Notation is delegated.** `Alg.fromString` gives us the full alg.cubing.net dialect for
free — `//` comments, `F2'`, lowercase wide moves, repeated tokens like `D D`, commutators
and conjugates — which is exactly what the reconstruction corpus is written in. Two things
we do *not* accept: layer-prefixed big-cube moves (`2U` parses as family `U` with
`innerLayer: 2`, so accepting it would silently apply a plain `U`), and any move family
outside the 18 modelled.

**The engine never cancels moves.** Reconstructions record what the solver's hands did, so
`U' U'` stays two moves. That matters for TPS and pause analysis in A3. Published STM
figures are canonical counts and will sometimes disagree — treat them as approximate
metadata, not ground truth.

## Scripts

| Command | Purpose |
|---|---|
| `npm run generate -w @cubing-companion/engine` | Regenerate `src/tables.generated.ts`. CI checks this is current. |
| `npm run fetch-fixtures -w @cubing-companion/engine` | Refresh the reco.nz test fixtures. Rate-limited; rarely needed. |

## Tests

`packages/engine/test/differential.test.ts` is the load-bearing one: random algs over
every family and alias, compared against cubing.js's KPuzzle. Since the tables come from
cubing.js, it is not testing them — it tests family/alias resolution, amount
normalization, composition, the apply loop, and notation, which are the parts we wrote.

`fixtures.test.ts` verifies 20 real reco.nz reconstructions end solved. Data from
<https://reco.nz>; each fixture credits its solver and reconstructor.
