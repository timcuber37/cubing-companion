# Phase 0: GAN i4 testing guide

The first hardware session is analyzed in [GYRO_RESULTS.md](GYRO_RESULTS.md). The tested cube
was identified as a GAN i Carry 4, which has no gyroscope; the export contains 332 face turns
and zero gyro samples. Another rotation test on that device is unnecessary. The procedure below
remains available for testing a gyro-equipped cube. The full roadmap is in [GYRO_PLAN.md](GYRO_PLAN.md).

## Start a recording

1. Run the app as usual with `npm run dev`, open it in a browser that can connect your cube,
   and click **Connect smart cube**.
2. Open **Gyro diagnostics**, directly below the connection status.
3. Leave **Cube mode** as **Unknown** unless you have verified the setting. The selector only
   labels the recording; it does not change the cube's mode.
4. Add a short note identifying the test, then click **Start recording**. This also sends a
   read-only request for hardware/firmware information.
5. Select a test step and click **Mark step start** before performing it. Markers are timestamps
   for later analysis, not ground-truth rotation labels.
6. Click **Stop and export JSON**, or stop first and export afterward. Save the downloaded file
   before starting another recording or reloading the page.

Recording continues across disconnect/reconnect within the same page. Each connection receives
its own epoch so gaps are not interpreted as movement. Recordings stop automatically at ten
minutes or 30,000 retained events. A limit produces an explicitly partial trace; it does not
discard the file. Recordings are kept in memory, not in solve history.

## Suggested first session

Start with two short recordings. They provide enough evidence to decide the next implementation
step without requiring a long battery or performance experiment.

**Recording A — stationary and deliberate rotations**

- Put the cube on a stable surface. Mark **Hold still — 60 seconds** and leave it still.
- Pick it up and hold white up, green toward you. Select **x rotations**, mark, pause two
  seconds, then perform `x`, pause, `x'`, pause, `x2`. Pause about two seconds between movements.
- Restore white up, green toward you before marking each of **y rotations** and **z rotations**.
  Repeat the same quarter/inverse/half sequence for that axis.
- Export. Note anything unexpected, including the cube sleeping during the still hold.

`x`, `y`, and `z` turn the whole cube in the direction of `R`, `U`, and `F`, respectively.
The return to the initial hold happens before the next marker. The cube need not be solved.

**Recording B — actual handling**

- Mark **Face turns and natural tilt** and perform `R U R' U'` several times while maintaining
  roughly the same hold.
- Mark **Wide and slice turns** and perform a few of those deliberately.
- Mark **Normal solve**, then scramble and solve normally. Scrambling and solve moves are both
  retained; the diagnostic recorder does not operate the solve timer.
- Mark **Reconnect / wake**, disconnect, and reconnect through the normal app controls.
- Export. A phone video synchronized to the visible marker clicks helps label ambiguous actions.

After these first traces, useful follow-ups are the five-minute still hold, faster consecutive
rotations, more normal solves, and a separate recording for each verified operating mode.
Use documented cube/app controls to change modes between recordings.

## Reading the panel

| Reading | What it establishes |
|---|---|
| Reported gyro yes/no/? | The library's hardware flag. Valid received samples can contradict a `no`. |
| Receiving / waiting / paused | Whether decoded orientation samples arrive during this recording. A 500 ms pause is a diagnostic threshold, not proof of packet loss. |
| Observed arrival rate and intervals | Host receipt spacing. It is not a guaranteed sensor update rate. Statistics omit intervals across reconnects. |
| Invalid quaternions | Missing/non-finite components, zero norm, or norm differing from one by more than 0.05. Raw values are retained; this provisional cutoff does not discard the event. |
| Missing gyro timestamps | Events without a finite library host timestamp. Adapter arrival is still retained. No device sample timestamp is invented. |
| Angle from marker / maximum | Angular distance from the first valid sample after a marker or connection. Quaternion sign changes do not create motion. Only a physically stationary test makes this useful for drift inspection. |
| Host dispatch | Time from the library's move host timestamp to the adapter callback. Batched moves without that timestamp are excluded. It does not measure sensor/radio latency. |
| Move handler | Synchronous work in the app's tracked-move callback. React commit and rendering costs are outside this number. |
| Planner | Request-to-completion time, including worker startup/model loading where applicable. Cancelled requests are excluded. The panel pools request types; each exported timing includes its type. |

If samples never arrive, export the trace anyway. Mode, firmware, advertised support, and the
absence of gyro events are useful evidence. The virtual cube continues to respond only to face
turns in Phase 0; it will not yet follow physical rotations or add them to scoring.

## Export contract

Files use format `cubing-companion.gyro-diagnostic`, schema version 1. They contain:

- Capture date, browser version, notes, user-reported mode, stop reason, and limits.
- Connection epochs with service UUIDs and protocol when available, library version, hardware,
  and `lastReportedFacelets`. That last field is a cached device report, not a guaranteed state
  at recording start; timestamped `FACELETS` events retain later reports.
- Ordered `GYRO`, `MOVE`, `HARDWARE`, `FACELETS`, connection, visibility, marker, and timing events.
- Raw quaternions and optional unscaled velocity. Non-finite/missing components become JSON
  `null` with an explicit validation issue. Unknown event fields are omitted.
- Host timestamps as offsets from capture start. Move device timestamps stay in their original
  device clock. `eventTimestampMs` is the library's host timestamp, not a sensor timestamp.

Device addresses, Bluetooth device identifiers/names, and encryption keys are not included.
The export preserves the notes entered by the user. Service metadata is best-effort because the
library's public connection interface does not promise access to its characteristic; unavailable
metadata is explicitly unknown rather than inferred from the model name.

## Reproducible checks before hardware testing

```sh
npm test -- packages/cube-link/test/diagnostics.test.ts packages/cube-link/test/gan.test.ts
npm run typecheck
node packages/cube-link/scripts/diagnostics-benchmark.ts
```

The benchmark reports disabled/recording CPU cost, summary computation cost, and export size for
12,000 synthetic packets. It is a local implementation baseline, not a hardware measurement.
For browser comparisons, use the same test steps and planner request types, label cold versus
warm runs in the notes, and retain raw timings so mixed workloads can be separated later.

## Hardware findings from the first session

| Question | Current result |
|---|---|
| Exact model and firmware | `GANic4`, hardware 1.0, firmware 1.1; replaceable battery confirmed by user, identifying i Carry 4 |
| Negotiated protocol/service | Gen4; `00000010-0000-fff7-fff6-fff5fff4fff0` |
| Usable quaternion stream / support flag mismatch | No gyro events; advertised support false; no observed mismatch |
| Typical and tail gyro arrival intervals | Unavailable: zero samples |
| Axis/sign relationship for x/y/z | Unavailable on this capture/device |
| Short and long stationary drift | Unavailable: missing orientation is not zero drift |
| Wide/slice motion ambiguity | Face turns retained, physical pose unobserved |
| Mode and reconnect behavior | Mode unknown; no actual reconnect event in retained window |
| Readable replay / action-count feasibility | Canonical replay verified; gyro-dependent work requires another orientation source |

See [the results and manufacturer references](GYRO_RESULTS.md) for evidence and limitations.
