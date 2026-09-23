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

So the project adopted `gan-web-bluetooth`. That reasoning still holds, but the library is now the
**reference implementation rather than a dependency** — see below.

## Why the protocol is vendored

`gan-web-bluetooth` calls `navigator.bluetooth.requestDevice` itself, from inside the same function
that selects the protocol driver. There is no seam: you cannot hand it a different radio. That is
fine in a browser and fatal on iOS, where Web Bluetooth does not exist and Apple has said it will
not. Getting onto a phone meant owning the protocol.

`src/gan/` is that port — encryption, the bit reader, the facelet conversion, the move-recovery
buffer and all three protocol drivers, running over a {@link BleTransport} instead of over the DOM.
About 800 lines, most of it a faithful copy, attributed in each file (MIT, Andy Fedotov).

**The library stays as a devDependency**, and `test/protocol.test.ts` diffs against it on every run:
every decoded event, every command message and every move-history request, over random messages for
all three generations and over all 1,213 frames of the committed capture. That is a stronger
guarantee than a golden file, and it means an upstream fix can be noticed rather than missed.

Four things changed on purpose rather than being copied:

- **`@noble/ciphers` replaces `aes-js`.** `aes-js` is CommonJS, which is what forced a lazy
  `await import()` in `gan.ts` — a static import made the module unloadable under Node's ESM loader,
  so the adapter could not be imported in tests at all. Verified byte-identical over the capture.
- **`rxjs` is gone.** The event stream was one `Subject`; the package already had `Listeners`.
- **A malformed facelet message is dropped, not fatal.** The reference indexes its facelet maps with
  whatever arrived, so a corrupted packet either throws out of the notification handler or — worse —
  reports a cube with duplicate edges and `NaN` orientations. Both happen on random input; both are
  a mangled BLE packet in the field. `isCube` checks first and the message is discarded.
- **Notifications are handled one at a time.** Decoding can await a write when it requests move
  history, and the reference calls it straight from the characteristic event, so two notifications
  arriving together interleave inside the move buffer. Here they queue.

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
turns only**. This face-turn stream does not directly encode rotations, wide moves, or slices.

`parseGanMove` rejects anything else rather than passing it through, even though the engine
would happily accept an `x`: a rotation appearing in a smart-cube stream would mean a
protocol misunderstanding had silently corrupted the tracked state.

The consequence for A3 is worth stating plainly: **rotation count is not comparable between
inputs.** Corpus reconstructions average ~3.5 rotations per solve; smart-cube solves will
have zero. Gen2 does emit GYRO quaternions, so inferring rotation from orientation is
possible later. Phase 0 now records decoded gyro events independently for diagnostics; it does
not infer rotations or include them in solve scores. See the
[GAN i4 testing guide](../../GYRO_TESTING.md) for the panel, export format, and hardware script.

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

### When things fall out of step

Three different things can disagree, and they need different remedies:

| what is wrong | fix |
|---|---|
| the tracked position drifted from the cube | `CubeTracker.verify()` — asks the cube and adopts its answer |
| the *display* drifted, while tracker and cube agree | push `tracker.getState()` at the player; `verify()` will not do it, because from its point of view nothing is wrong |
| the **cube itself** lost track | `GanCubeSource.resetToSolved()` — hold a solved cube and say so |

The third is the one that looks like a broken sync. A cube keeps its own idea of the position from
its sensors and can be wrong — turned while asleep, or a fast half turn read as a quarter. Reading
it then reports the mistake faithfully, and no amount of re-reading helps. `REQUEST_RESET` is the
only way back, and it is destructive: it discards whatever the cube believed, so it is only
correct when the cube really is solved.

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

GAN cubes derive their encryption key from the device MAC, and Web Bluetooth deliberately does
not expose it. The library recovers it from the cube's advertisement data on platforms that
support `watchAdvertisements()`, which is most of them.

`macAddressPrompt` is called **twice**: once before the library tries to detect the address, and
again as a last resort if that failed. Answer only the second. Answering the first puts a dialog
in front of every user, including the great majority who never needed one — which is exactly what
the app did until somebody pointed out that their cube connected fine on its own.

## The BLE transport seam

`ble/transport.ts` describes a radio in eight operations: is it available, present a chooser and
connect, list services, write, subscribe, watch for disconnection, hang up. Three implementations
satisfy it — `ble/web.ts` over Web Bluetooth, `ble/fake.ts` over a recorded frame log, and a native
bridge later — and nothing above the seam learns which it got.

It exists because `gan-web-bluetooth` offers no such seam. `connectGanCube` takes a MAC provider
and calls `navigator.bluetooth.requestDevice` itself, so there is nowhere to hand it a different
radio. That is fine on the web and fatal on iOS, where Web Bluetooth does not exist and will not.
[`MOBILE_PLAN.md`](../../MOBILE_PLAN.md) has the reasoning and the phases.

Two things fall out of it that are worth having regardless of any phone:

- **`navigator` appears in exactly one file**, enforced by `test/boundaries.test.ts`. The pure
  sources — `source.ts`, `manual.ts`, `replay.ts`, `tracker.ts`, `timeline.ts`, `diagnostics.ts` —
  are checked for `window` and `document` too. They are what a native port reuses unchanged.
- **The protocol becomes testable.** `FakeTransport` replays a capture byte for byte, so a decoder
  can be developed and regression-tested on a machine with no Bluetooth. The untestable surface
  shrinks to `ble/web.ts`, which is a translation layer and nothing else.

### Capturing frames

`captureProtocolFrames` connects, works out which generation the cube speaks, subscribes to its
state characteristic and writes down the encrypted frames. The point is to get one real cube's
bytes into the repository so the driver can be built against something that happened.

It is **passive**. It cannot ask the cube anything, because every command is encrypted and that
encoder is what the fixture is for. That costs less than expected: a Gen4 cube volunteers more
than its moves. The committed capture — `test/fixtures/gan-gen4-frames.json`, 137 seconds of a
real i Carry 4 — holds 1,063 move frames, 138 periodic facelet reports and 11 battery reports,
none requested. Only true request/response traffic (hardware info, move-history recovery, reset)
needs the encoder.

A capture **contains the cube's MAC address**, and must: the frames are keyed from it. That is a
deliberate departure from `diagnostics.ts`, whose export allowlists fields precisely to keep
device identifiers out. Two artifacts, two contracts, kept apart rather than by weakening the one
that promised not to do this — and the panel that produces it says so before you export.

### MAC recovery, per platform

`mac.ts` is small and carries most of the platform risk in the port, because a GAN cube's key is
salted with its MAC and the MAC appears in exactly one place: the last six bytes of an
advertisement's manufacturer data, reversed.

| Platform | How the address is obtained |
|---|---|
| Web Bluetooth | `watchAdvertisements()` where it exists, else ask the user |
| Android native | The device id *is* the address |
| iOS native | Hidden as thoroughly as on the web — but Core Bluetooth does surface manufacturer data during a scan |

So iOS is workable, with one catch that shapes the design: **a reconnect by device id produces no
advertisement**, and therefore no key. A cube you have already paired with is unreadable unless
the address was kept. That is what `GanMacStore` is for, and why it is persisted rather than
cached — losing it means asking someone to forget and re-pair their cube.
