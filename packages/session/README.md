# @cubing-companion/session

Solve capture and local-first storage. Turns a live move stream into stored, segmented solve
records — A2's stated deliverable.

Depends on `engine`, `analysis` and `cube-link`. Depending on the input adapters is this
layer's job: the rule `PLAN.md` sets is that *analysis* never does, and it does not.

```ts
const recorder = new SolveRecorder({ sessionId, source: "smart-cube" });
recorder.arm(scramble, tracker.getState());

tracker.onMove((move) => {
  recorder.handleMove(move);              // before handleState — see below
  recorder.handleState(tracker.getState());
  const state = recorder.getState();
  if (state.phase === "complete") void store.putSolve(state.record!);
});
```

## A record stores the position, not the scramble

`startFacelets` is authoritative; `scrambleText` is display text with a `scrambleMatched`
flag beside it.

The obvious design keeps the scramble the app generated and assumes the cube matches it. It
frequently does not: the solver mis-scrambles, adds a correcting turn, or holds the cube
rotated so the same written moves reach a conjugated position. In each case the intended
scramble stops describing the cube, and anything derived from it is wrong — while the position
is always true.

The payoff is concrete. A mis-scrambled solve still segments correctly instead of being
discarded, and "start from here" is a one-liner rather than a special case. `segmentRecord`
reads `startFacelets` and never looks at the scramble at all.

## The state machine

```
idle ──arm(scramble, current)──▶ scrambling ──cube reaches it──▶ ready
                                                                  │ first move
                                                                  ▼
              complete ◀────── cube solved ────────────────── solving
```

**Why there is no way back out of `ready`.** It is tempting to add one: if the cube stops
matching the scramble before the solve begins, surely the solver is still fiddling? But the
first move of a real solve leaves the target position in exactly the same way, so from state
alone the two are the same observation. Guessing would either swallow the first move of real
solves or start the clock during scrambles. The first turn after `ready` starts the solve, and
`discard` is the remedy — which is how timers behave anyway.

**Why `arm` needs the current position.** Arming a cube that already matches has to land in
`ready` immediately. Waiting for the next state report would leave a correctly scrambled cube
stuck in `scrambling`, and the next thing to move it would be the solver starting to solve.

**Why `handleMove` comes before `handleState`.** The move that solves the cube belongs to the
solve. Reversing the order files it after the solve has already ended.

## Timing, and what it is not

Duration runs from the first **turn** to the last. **That is not a stackmat time** — it excludes
inspection and the hand movement a timer captures. This is precisely why reco.nz removed its
smartcube reconstructions, and why A3 must not score these against corpus percentiles without
saying so. Both the type and the UI say it.

### Pasting is setup; turning is solving

Once every attempt arms itself from a generated scramble, a paste into the algorithm box has
nowhere sensible to go: while `ready`, its first move would start an attempt nobody meant to
make, and there would be no way left to set up a position of your own — finishing or discarding
just re-scrambles.

So outside a running solve a paste moves the cube and re-arms from wherever it lands, exactly as
"Start from here" does. During a solve it is part of the solve, which is how a pasted
reconstruction still gets recorded.

### Rotations before the first turn are inspection

A rotation solves nothing: it is the solver deciding how to hold the cube, which under WCA rules
belongs to the 15 seconds of inspection, before the attempt begins. The corpus agrees about what
they are for — pros rotate **1.45 times before their first turn** and only 0.23 times across the
whole cross.

So a leading run of rotations is left out of `moveCount`, and the clock does not start until the
first turn. They stay in `solution`, because *which* grip was chosen is exactly what A4 recommends
and B3 models; throwing them away would discard the more interesting half of the decision.

Only the leading run counts as inspection. A rotation in the middle of a solve is a regrip that
cost real time, and is counted like any other move.

On completion the recorder runs `MoveTimeline.retime` over the whole stream. Live, the timeline
cannot place moves that arrived before the first host timestamp — a real consequence of BLE
batching — but with the solve finished, every move can be fitted.

**Timing that no hand produced is withheld.** Pasted algorithms and replays land every move
within a millisecond, which would report a sub-second solve at thousands of turns per second.
Past 50 turns per second — more than triple any human — `durationMs`, `tps` *and* the per-move
timestamps all come back `null`, so phase durations cannot report a confident `0.00s` beneath a
solve whose time reads unknown.

## Storage

`SolveStore` has two implementations behind one contract test, so they cannot drift:
`IndexedDbStore` for the browser and `MemoryStore` for tests, server rendering, and browsers
that refuse to open a database. `PLAN.md`'s "sync later (Turso/Postgres)" becomes a third
implementation rather than a rewrite.

Records are plain JSON — moves as notation, positions as facelet strings. Nothing stores a
`CubeState` or a `Move[]`, so a record stays readable after the engine's internals change and
survives the trip to a server.

Segmentation is **derived on read**, not stored. It costs microseconds, and it means improving
the segmenter improves every solve already recorded. That is not hypothetical: the segmenter's
agreement with human labels went from 0% to 97% over one afternoon.

## Scrambles

The app asks for `generateScramble()` from the engine, which prefers WCA-style random-state and
falls back to random-move — **reporting which it produced**, because the two sample positions
differently and the UI needs to say so.

The fallback is not theoretical. cubing.js runs its random-state solver in a Web Worker loading
WASM, and Turbopack cannot instantiate it: `Module worker instantiation failed`. A failed worker
never settles rather than rejecting, so the attempt is raced against a timeout.
