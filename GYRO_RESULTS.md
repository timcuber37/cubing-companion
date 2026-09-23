# Phase 0 results — 9 September 2026

The export is structurally valid and contains a consistent face-turn reconstruction. It contains
**zero gyro samples**, so it cannot establish rotation accuracy, gyro update rate, or drift.

The connected device reports `GANic4`, hardware `1.0`, firmware `1.1`, using the Gen4 protocol.
Together with the user's confirmation of a replaceable battery, this identifies the tested cube
as the **GAN i Carry 4**. GAN distinguishes that product from the rechargeable i4 and lists the
i Carry series as having no gyroscope. The earlier plan assumed the gyro-equipped i4; that
assumption does not apply to this device. [GAN i Carry 4 specifications](https://www.gancube.com/products/gan-i-carry-4-smart-cube),
[GAN series comparison](https://www.gancube.com/pages/introduction).

## Recording integrity

Input: `gan-gyro-2026-09-09T22-12-13-106Z.json`, 247,868 bytes.

SHA-256: `8f1b6458d8cb55187e8b4eb2b87e3ad96da0fed33aab74f21e753c8efa76134b`.

| Check | Result |
|---|---|
| Format / schema | `cubing-companion.gyro-diagnostic`, version 1 |
| Capture start | 2026-09-09 22:12:13.106 UTC |
| Duration / end reason | 600 seconds; automatic duration limit |
| Events | 968, with consecutive ordinals and nondecreasing finite timestamps |
| Face-turn events | 332 |
| Facelet reports | 620 |
| Gyro events | 0 |
| Test markers | 12 |
| Connection epochs / disconnect events | 1 / 0 |
| Advertised gyro support | `false` |
| Cube mode | User left it unknown; the export does not verify an operating mode |
| Reported summary counts | Match the actual event arrays |

All events fall inside the capture interval. The final event arrives at 599.178 seconds; the
file stops at the configured ten-minute limit. This is a valid bounded capture, not a malformed
or unexpectedly cut-off JSON file. Actions after the limit are outside this export.

## Face-turn reconstruction

The 332 recorded moves form a continuous serial sequence modulo 256, starting at serial 2
after an initial state report at serial 1. There are no unresolved serial gaps or duplicate
serials between successive recorded moves. Known device timestamps do not run backward.

Starting from the first reported cube state, I replayed the moves through the project's engine
and matched every one of the **620 facelet reports** to its corresponding move serial. All
matched, and the final reconstructed state is solved. Five reports arrived ahead of the moves
needed to reach them in the adapter's output; their matching moves subsequently arrived. Their
lead was 5, 3, 2, 1, and 1 moves, respectively.

This establishes internal consistency between the retained move history and reported states.
It is not independent video validation of every physical action, nor proof that every BLE
notification was received immediately.

**23 of 332 moves (6.9%) have neither a device timestamp nor a move host timestamp.** In the
installed Gen4 driver, this is the signature of moves recovered through history. All 23 retain
an event receipt time and correct serial position, but exact execution timing is unavailable.
Recovered order is useful for reconstruction; it should not be mistaken for measured pause
duration or fine-grained execution timing.

## Test coverage

Markers label intervals until the next marker. They do not automatically record which physical
motion occurred, and repeated markers do not imply repeated hardware actions.

| Marked interval | Start | Span to next marker/end | Face turns | Gyro samples |
|---|---|---|---|---|
| `still-60s` | 2.168 s | 395.824 s | 0 | 0 |
| `x` (first marker) | 397.992 s | 4.823 s | 0 | 0 |
| `x` (second marker) | 402.815 s | 11.917 s | 0 | 0 |
| `y` | 414.733 s | 54.654 s | 0 | 0 |
| `fast-rotations` | 469.387 s | 43.410 s | 156 | 0 |
| `wide-slice` | 512.796 s | 20.633 s | 74 | 0 |
| `solve` (first marker) | 533.430 s | 25.853 s | 102 | 0 |
| Remaining solve/reconnect markers | 559.283–583.830 s | Through 600 s | 0 | 0 |

There is no separate `z` or `face-turns` marker. The `fast-rotations` interval includes face
turning, so its name alone cannot serve as an isolated rotation label. No actual disconnect or
second connection is present despite the reconnect markers. The recorded stream therefore does
not validate reconnect handling. These coverage limits do not change the main finding: no
orientation samples were present anywhere in the capture.

## Timing observations

| Measurement | Count | Median | p95 | Maximum |
|---|---|---|---|---|
| Move host timestamp to adapter receipt | 309 | 0.60 ms | 138.20 ms | 1,302.70 ms |
| Intervals between facelet reports | 619 | 990.10 ms | 1,036.20 ms | 1,082.60 ms |
| Planner completion | 1 | 2,595 ms | Insufficient sample | 2,595 ms |
| App move-handler timing | 0 | Unavailable | Unavailable | Unavailable |

I recomputed the move dispatch statistics from the events; they match the exported summary.
The long dispatch tail can include time in the protocol library's move-recovery buffer. It is
not a direct measurement of radio latency or synchronous UI work, and cannot by itself identify
a slow app callback. Facelet reports arriving regularly also show that the connection was active
while no gyro events arrived.

One planner observation does not establish typical or tail performance. This export also lacks
the request-type field now emitted by the current timing code. It has no move-handler timing
events, so the planned application-performance baseline is incomplete. The file does not prove
why those events are absent; an older live callback/module instance is one possible explanation.

## Decision and next work

- **Capture validation:** passed for the retained decoded move/state trace.
- **Gyro feasibility on the tested cube:** no usable stream, consistent with the i Carry 4's
  lack of gyro hardware. Changing a support flag or adding filtering cannot supply missing
  orientation measurements. Repeating stationary/rotation tests on this device is unnecessary.
- **Rotation scoring:** keep it unavailable for these records. Zero observed gyro samples is
  not evidence that zero rotations occurred.
- **Gyro-specific phases:** positive hardware validation requires a cube with a gyroscope or
  a different orientation source. The trace contains decoded library events, not raw radio
  packets; the hardware conclusion also uses the confirmed device family and manufacturer data.
- **Deeper planning:** x-cross, cross + 1/+2, continuation search, and model evaluation can
  continue using canonical cube state. Measured physical-hold features remain unavailable on
  this cube; inferred/manual viewing frames remain possible.
- **Future diagnostics:** show the confirmed product family and a clear no-gyro explanation;
  distinguish recovered move timing from immediate delivery; capture an app build identifier
  and verify timing instrumentation before a new performance benchmark.

The useful outcome of this test is a verified hardware limitation and a healthy retained move
history. It does not validate the orientation assumptions for the separate GAN i4 product.
