# @cubing-companion/cube-link

Cube input adapters. One interface, several sources — a GAN smart cube over Web Bluetooth,
manual keyboard and paste entry, and recorded replay.

Downstream code consumes `CubeSource` and never learns which it got. That is what `PLAN.md`
means by an input-agnostic analysis engine, and it is why this is a separate package:
**analysis must never import from here.**

```ts
const source = await connectSmartCube();   // or new ManualSource()
const tracker = new CubeTracker(source);

tracker.onMove((m) => player.addMove(m.move));
tracker.onReseed((state) => player.setState(state));
await tracker.start();
```

## Why not `cubing/bluetooth`

cubing.js ships smart cube support, and it was the obvious first choice. It turned out to
be the wrong one for GAN:

- Its GAN driver binds service `0000fff0` — **Gen2 only** — while `gan-web-bluetooth`
  covers Gen2, Gen3 and Gen4.
- More importantly, it drives the cube by **polling** (`setInterval`), reserving BLE
  notifications for GiiKER and GoCube. Polling quantises every move timestamp to the poll
  period, which destroys exactly the TPS and pause precision A3 is built to measure.

The cost is two dependencies (`rxjs`, `aes-js`) and a library last published in Aug 2024.
Worth it. All protocol-specific code is confined to `src/gan.ts`.

## Timestamps, and why there are two clocks

This is the part `PLAN.md` flagged in advance — "expect batching jitter" — and it is real.

A GAN cube reports two timestamps per move:

| | What it means | Catch |
|---|---|---|
| `localTimestamp` | when the BLE packet arrived | **null on batched moves** |
| `cubeTimestamp` | when the turn actually happened, by the cube's clock | its own epoch, its own rate |

When you turn quickly, several moves arrive in a single packet. Only the newest gets a host
timestamp; the rest are reconstructed and carry `null`. So host time cannot be the source of
per-move timing. Cube time can — but it runs at its own rate and drifts measurably.

`MoveTimeline` least-squares fits cube time onto host time using the moves that carry both.
Fitting rather than offsetting matters: a fixed offset taken at the start of a solve
accumulates error as the clocks diverge. A test asserts the fit beats a plain offset by two
orders of magnitude over 100 moves with 2% skew.

Two entry points:

- `timeline.add(event)` — live. Honest about what it cannot yet know: moves before the
  first host timestamp report `timestampSource: "none"` rather than inventing a number.
- `MoveTimeline.retime(events)` — a whole finished stream. Fits over everything, so every
  move gets placed. **This is what A3's TPS and pause metrics should use.**

## Desync, and why it needs two defences

A Bluetooth move stream is lossy, and the failure is silent — nothing throws, the virtual
cube just quietly stops matching the real one.

1. **Serial gaps.** Every move carries a sequence number advancing by one per state change,
   wrapping at 256. A jump means packets were missed. Cheap and immediate, but blind to a
   cube turned while nothing was listening.
2. **Facelet comparison.** Ask the cube what it actually shows and compare. Authoritative,
   but a round trip — so it runs on suspicion and on a slow timer, not per move.

Recovery is always the same: adopt the cube's state and emit a `DesyncEvent`. A re-seed also
resets the clock fit, since the moves either side of it are not one continuous stream.

`CubeTracker` is pure logic over an injected source, so all of this is unit-tested with a
fake and none of it needs hardware.

## What the cube cannot tell you

The Gen2 protocol builds moves as `"URFDLB"[face] + " '"[direction]` — **outer-face quarter
turns only**. A smart cube senses no rotations, no wide moves, no slices.

`parseGanMove` rejects anything else rather than passing it through, even though the engine
would happily accept an `x`: a rotation appearing in a smart-cube stream would mean a
protocol misunderstanding had silently corrupted the tracked state.

The consequence for A3 is worth stating plainly: **rotation count is not comparable between
inputs.** Corpus reconstructions average ~3.5 rotations per solve; smart-cube solves will
have zero. Gen2 does emit GYRO quaternions, so inferring rotation from orientation is
possible later — it is not attempted here.

## Interchange is facelets, not piece arrays

GAN reports state as `{CP, CO, EP, EO}` — the same shape as our `CubeState`, but **not the
same indexing**. After `F R` they report `cp = [0,5,2,1,7,4,6,3]` where the engine reports
`[0,3,2,5,7,4,6,1]`. Corner *orientation* happens to agree; permutation does not.

Rather than reverse-engineer their convention, both sides speak the Kociemba facelet string,
which is a published standard. `@cubing-companion/engine`'s `toFacelets`/`fromFacelets` is
verified against a vector from GAN's own documentation.

## Sources

| Source | Use |
|---|---|
| `GanCubeSource` | The real cube. Needs Chromium and a user gesture. |
| `ManualSource` | Keyboard and pasted algorithms. A first-class input, not a fallback — it is what keeps A2 and A3 buildable without hardware. |

### Placing a virtual cube

A real cube gets scrambled by hand; a virtual one has to be put there. `ManualSource.setState`
and `CubeTracker.reseed` do that together, and both are deliberately **silent** — no move events.
Turning a scramble in would put it in the move log for the recorder to count, and applying the
scramble as moves would land somewhere else entirely whenever the cube was not already solved,
since a scramble describes solved-plus-those-moves rather than a relative sequence.

It surfaces as a `set-directly` desync rather than a `state-mismatch`, because nothing drifted —
reporting it as a fault would tell the diagnostics panel the link had failed every time somebody
asked for a new scramble.
| `ReplaySource` | Plays a recording. `recordingFromAlg` can synthesise batching, clock skew and dropped serials on demand, which is how the awkward cases get tested at all. |

## MAC addresses

GAN cubes derive their encryption key from the device MAC, and Web Bluetooth deliberately
does not expose it. The library recovers it automatically on most platforms; pass
`macAddressPrompt` for when it cannot. Expect this to be the most common first-run snag.
