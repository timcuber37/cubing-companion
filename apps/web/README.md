# @cubing-companion/web

The A1 harness: connect a smart cube and watch a virtual one follow.

```sh
npm run dev            # from the repo root, or: npm run dev -w @cubing-companion/web
```

Then open <http://localhost:3000>. Web Bluetooth permits `localhost` without HTTPS, so no
tunnel or certificate is needed for development.

## Deliberately a harness, not an app

A1's stated deliverable is "turn the physical cube, watch the virtual one follow", so this
is the smallest thing that proves the mechanism: a connect button, the virtual cube, a move
log, sync status, and manual input. A2 will restructure this around session recording and
A3 around scoring, so polish here would be thrown away.

The one place effort *was* spent is the move log, which shows both clocks and how each
timestamp was derived. BLE batching is the thing most likely to surprise you, and the log
makes it visible rather than leaving it to be inferred from odd numbers later.

## Layout

| Path | Role |
|---|---|
| `components/CubeHarness.tsx` | Wires a `CubeSource` to the tracker, the player, and the UI |
| `components/TwistyPlayer.tsx` | Wraps cubing.js's `<twisty-player>` custom element |
| `components/MoveLog.tsx` | The move stream, both clocks, and timestamp provenance |
| `components/ManualInput.tsx` | Keyboard turning and pasted algorithms |

## Two integration details worth knowing

**The twisty player is a custom element, not a React component.** `cubing/twisty` registers
custom elements and touches `document` on import, so it cannot run during server rendering.
It is imported inside an effect — client-only, and out of the initial bundle — and driven
imperatively through a ref.

**Re-seeding does not need a solver.** After a desync the tracker supplies a `CubeState`,
and the player is repositioned by building a `KTransformation` from the piece arrays
directly. That works only because the engine adopted cubing.js's piece indexing back in A0;
without that, this would need a solve step to turn a state into a setup algorithm.

## Browser support

Smart cube connection needs Web Bluetooth: **Chrome or Edge on desktop, Chrome on Android.**
Safari does not implement it and iOS cannot, at any browser. The page feature-detects and
says so rather than failing at the click. Manual input works everywhere.

## Generated files

`AGENTS.md` and `CLAUDE.md` are written by `next dev` itself, not by hand. Next re-creates
them on every dev run, so they are committed rather than ignored — deleting them only makes
them reappear as uncommitted changes.
