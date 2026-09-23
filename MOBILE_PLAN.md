# iOS and Android via Capacitor: phased implementation plan

Status: proposed implementation plan, 21 September 2026. No mobile device has been tested. Estimates
below are engineering effort, not delivery commitments. Distribution target is personal sideload —
no App Store, no TestFlight, no developer-account spend.

**P0 is implemented.** The ONNX runtime is gone, scramble generation has its own entry point, and
the app is installable. Measured result: the production build now contains **no WebAssembly at
all** and its entire static payload is 2.8 MB.

**P1 is implemented, fixture included.** The transport seam exists, `navigator` appears in exactly
one file and a boundary test enforces it, and 137 seconds of a real GAN i Carry 4 is committed at
`packages/cube-link/test/fixtures/gan-gen4-frames.json`. The frames were verified to decrypt before
being committed — see *What the capture proved* below.

**P2 is implemented.** The GAN protocol is vendored into `packages/cube-link/src/gan/` and runs over
the transport seam; `gan-web-bluetooth`, `aes-js` and `rxjs` are gone from the shipping bundle. All
three protocol generations are diffed against the reference implementation on every test run.
Recovered moves get interpolated timestamps instead of being dropped from the metrics.

**P3 is done, verified on hardware.** The app is installed on an iPhone 11 (iOS 26.5.2) and
**connects to the GAN i Carry 4 over native Bluetooth**. That is the end of the blocker
[PLAN.md](PLAN.md) declared: the static export runs under `capacitor://localhost`, the twisty
player renders in 3D in WKWebView, and the vendored protocol decodes a real cube over Core
Bluetooth instead of Web Bluetooth.

The `BleTransport` seam did what it was built for — the same decoder, the same move buffer and the
same timeline now run over three radios (Web Bluetooth, Capacitor, and a recorded capture) with no
change above the seam.

**P4 is implemented.** Solve history is in SQLite in the app container rather than in evictable
WebView storage; the screen stays awake through inspection and the solve; a suspended app notices
its cube has gone; and the UI is three tabs with a docked primary action instead of a desktop
two-column grid.

**P5 is done, and it is the phase that produced a number rather than a feature.** Measured on an
iPhone 11 against the same workload on the development Mac:

| | Desktop | iPhone 11 | Ratio |
|---|---:|---:|---:|
| Cross tables, cold | 591 ms | 2,208 ms | 3.7× |
| One colour | 425 ms | 966 ms | 2.3× |
| Colour-neutral sweep, median | 2.32 s | 5.45 s | 2.4× |
| Next pair + lookahead | 161 ms | 372 ms | 2.3× |

**2.4× a desktop, not the order of magnitude that was feared.** That matters beyond this phase: it
is the measurement [SWIFT_PLAN.md](SWIFT_PLAN.md) asks for before committing to a native rewrite,
and it weakens the performance argument for one considerably.

[PLAN.md](PLAN.md) declares the project's one hard platform limit: *"No iOS (Web Bluetooth doesn't
exist on iOS Safari; native wrapper is a someday-item)"*, with "iOS via native wrapper" parked in
B4 stretch. With A0–A5 and B1–B3 shipped, that limit is now the biggest gap between the app and the
people who would use it. This plan removes it.

## Objective and starting point

Run the existing app on an iPhone and an Android device, connected to the GAN i Carry 4, by the
cheapest honest route. Mobile becomes the primary surface; the web app is demoted to a desktop and
development surface, sharing one codebase.

**The decision: Capacitor.** Exactly one thing in the app breaks on iOS — the 25 lines of Web
Bluetooth in [gan.ts](packages/cube-link/src/gan.ts) (`isWebBluetoothAvailable` at line 47,
`connectSmartCube` at line 347). Everything else already runs in a WebView: the `<twisty-player>`
renderer, the planner Web Worker, IndexedDB, all 9,800 lines of [apps/web](apps/web). Three of the
six phases below need no phone, no Xcode and no Apple account, and each ships an improvement to the
web app on its own.

The intended release order is:

1. Remove the two payload and purity problems that would sink any mobile target (P0).
2. Introduce a BLE transport seam and capture real protocol frames as a CI fixture (P1).
3. Vendor the GAN protocol onto that seam, proven by differential test (P2).
4. Put the existing app on the phone and connect the cube (P3).
5. Make it durable, resumable and phone-shaped (P4).
6. Make the planner meet a latency budget on device, not on a Mac (P5).

P0–P2 are pure web-app improvements and carry no mobile risk. P3 is the gate: until a real cube
connects over Core Bluetooth, everything after it is speculative.

## Why not the alternatives

| Path | Verdict |
|---|---|
| **React Native / Expo** | iOS grants the JIT entitlement only to WKWebView's out-of-process WebContent process. React Native's JS runs in-process, so Hermes and JSC are both interpreter-only — expect the colour-neutral sweep to go from ~1.9 s to 10–25 s, against a 15-second inspection window. Hermes also has no WebAssembly, making WCA-legal scrambles impossible. 10–14 weekends for a measurably worse app. |
| **PWA only** | Free, and worth doing anyway as part of P0, but Android-only. Apple's stated position is that Web Bluetooth's permission model is unfixable, so this never reaches the actual goal. |
| **Native Swift + Kotlin** | Two rewrites of the ~8,000 lines in [packages](packages). Its one real advantage — background BLE and Core Bluetooth state restoration — is a feature this app does not want; you are looking at the screen while you solve. |

## Findings that shaped this plan

Four things turned up during investigation. Three are defects in what ships today, independent of
mobile.

**1. `onnxruntime-web` ships a 27.8 MB WASM runtime to evaluate a 2.9 KB model.**
`apps/web/.next/static/media/ort-wasm-simd-threaded.jsep.*.wasm` is 27,797,172 bytes, fetched on
first planner use; `node_modules/onnxruntime-web` is 136 MB. The model it runs is
`Linear(n→16)→ReLU→Linear(16→8)→ReLU→Linear(8→1)` with normalization baked in as buffers
([ml/data.py](ml/data.py), lines 136–165) — about 50 lines of TypeScript. On a phone over cellular
this is the difference between a usable app and an unusable one.

**2. cubing.js does embed WebAssembly**, base64-inlined in
`node_modules/cubing/dist/lib/cubing/chunks/twips_wasm_bg-*.js` (704 KB, opening with
`__toBinary("AGFzbQAAAAB...")` — the `\0asm` magic number), which is why searching for `.wasm` files
misses it. So `randomScrambleForEvent` needs both a Worker and WebAssembly. Under Capacitor both
exist; this is only fatal for React Native.

**3. [packages/engine](packages/engine) is not cleanly portable through its barrel.**
[index.ts](packages/engine/src/index.ts) lines 65–73 re-export
[scramble.ts](packages/engine/src/scramble.ts), which statically imports `cubing/scramble` and
`cubing/search` — dragging the WASM search graph into every consumer's module graph. Only two files
actually want it: [CubeHarness.tsx](apps/web/components/CubeHarness.tsx) and
[PlannerPanel.tsx](apps/web/components/PlannerPanel.tsx).

**4. Recovering the cube's MAC address is harder than "native exposes manufacturer data."**
GAN derives its encryption key from the MAC, which it broadcasts in the last 6 bytes of
advertisement manufacturer data. iOS hides the real MAC exactly as Web Bluetooth does — you get a
per-app `CBPeripheral.identifier` UUID. The MAC is recoverable **only from a scan advertisement**, so
reconnecting by identifier yields no advertisement and therefore no key. The transport design has to
cache `deviceId → MAC` itself. Done right, this deletes the `window.prompt` fallback in
[CubeHarness.tsx](apps/web/components/CubeHarness.tsx) — native is genuinely better here than Web
Bluetooth, just not for free.

Also load-bearing: `connectGanCube` in `gan-web-bluetooth` takes exactly one parameter, a MAC
provider, and calls `navigator.bluetooth.requestDevice` directly. **There is no transport injection
point**, so "wrap the library" is not available. Vendoring is the only honest option.

## Architecture and invariants

The existing seams are already in the right places:

- [CubeSource](packages/cube-link/src/source.ts) — [manual.ts](packages/cube-link/src/manual.ts),
  [replay.ts](packages/cube-link/src/replay.ts), [tracker.ts](packages/cube-link/src/tracker.ts),
  [timeline.ts](packages/cube-link/src/timeline.ts) and
  [diagnostics.ts](packages/cube-link/src/diagnostics.ts) are pure and transport-agnostic, proven by
  tests that use only `ReplaySource` and synthetic events.
- `GanConnectionLike` in [gan.ts](packages/cube-link/src/gan.ts) (lines 98–107) — a narrow structural
  interface the tests already fake. **This interface does not change.** The vendored connection
  implements it, so `GanCubeSource`, `diagnostics.ts`, `CubeHarness.tsx` and the existing test suite
  are untouched by the vendoring. This is the invariant that keeps the blast radius to one file plus
  one new directory.
- `SolveStore` in [store.ts](packages/session/src/store.ts) (lines 10–23) — already has two
  implementations and a shared contract test. SQLite becomes a third.
- `ScoreFn` in [rank.ts](packages/planner/src/rank.ts) (line 36) — injected, with heuristic fallback
  when absent. The model is already decoupled; it simply has no pure implementation to inject yet.

New code lands here:

```
apps/mobile/                      Capacitor shell. NO application code — syncs apps/web's static export.
packages/cube-link/src/ble/       transport.ts (pure), web.ts, capacitor.ts, fake.ts
packages/cube-link/src/gan/       vendored protocol: definitions, encrypter, messageView, gen2/3/4, connection
packages/session/src/sqlite.ts    SqliteSolveStore
packages/planner/src/mlp.ts       pure-TS scorer replacing onnxruntime-web
```

`apps/mobile` deliberately holds no components. Web and mobile are the same bundle; divergence is
responsive layout and capability detection, not a second component tree. Maintaining the 677-line
[SolveDetail.tsx](apps/web/components/SolveDetail.tsx) twice is not a trade worth making.

### The transport interface

```ts
// packages/cube-link/src/ble/transport.ts — pure, no platform imports

export interface BleAdvertisement {
  /** Platform handle: a Web Bluetooth device id or a CoreBluetooth UUID. NOT a MAC. */
  readonly deviceId: string;
  readonly name: string | null;
  /** Company Identifier Code → payload, as broadcast. GAN hides the MAC in here. */
  readonly manufacturerData: ReadonlyMap<number, Uint8Array>;
  readonly serviceUuids: readonly string[];
}

export interface BlePeripheral {
  readonly deviceId: string;
  write(service: string, characteristic: string, data: Uint8Array): Promise<void>;
  /**
   * `receivedAt` is stamped as near the radio as the platform allows — under a native
   * bridge that includes bridge latency, which is exactly why the cube's own clock,
   * not this, is the per-move truth. See timeline.ts.
   */
  subscribe(service: string, characteristic: string,
            onValue: (data: Uint8Array, receivedAt: number) => void): Promise<Unsubscribe>;
  onDisconnect(listener: () => void): Unsubscribe;
  disconnect(): Promise<void>;
}

export interface BleTransport {
  readonly kind: "web-bluetooth" | "capacitor" | "fake";
  isAvailable(): Promise<boolean>;
  /**
   * `advertisement` is null when the platform connected without scanning — the reconnect
   * case, and the reason GanMacStore exists.
   */
  requestDevice(filter: BleScanFilter): Promise<{
    peripheral: BlePeripheral;
    advertisement: BleAdvertisement | null;
  }>;
}

/** Caches deviceId → MAC, because a reconnect yields no advertisement to recover it from. */
export interface GanMacStore {
  get(deviceId: string): Promise<string | null>;
  set(deviceId: string, mac: string): Promise<void>;
}
```

`src/ble/web.ts` is the only file in the package allowed to say `navigator`. `src/ble/capacitor.ts`
uses `BleClient.requestLEScan` rather than `requestDevice`, because only the scan callback carries
`manufacturerData`.

Transport selection stays explicit and injectable rather than sniffed at call sites: a
`defaultTransport()` in `apps/web/components/platform.ts`, with `@capacitor/core` in
`optionalDependencies` and a dynamic import, so a plain web build never loads it.

### Vendoring scope

For Gen4, which is what the i Carry 4 speaks, from `node_modules/gan-web-bluetooth/src/`:

| Source | Lines | Treatment |
|---|---|---|
| `gan-cube-definitions.ts` | 37 | verbatim |
| `gan-cube-encrypter.ts` | 103 | ~60 kept; swap `aes-js` for `@noble/ciphers` |
| `GanProtocolMessageView` (`gan-cube-protocol.ts:262-292`) | 30 | verbatim |
| `GanGen4ProtocolDriver` (`gan-cube-protocol.ts:788-1119`) | 332 | verbatim, pure |
| `toKociembaFacelets` (`utils.ts:110-160`) | 50 | verbatim |
| protocol types (`gan-cube-protocol.ts:1-145`) | 145 | verbatim |
| `GanCubeClassicConnection` (`gan-cube-protocol.ts:191-260`) | 70 | **rewrite** over `BleTransport`, ~85 lines |
| MAC extraction (`gan-smart-cube.ts:16-39`) | 25 | verbatim, fed from `BleAdvertisement` |
| device selection (`gan-smart-cube.ts:77-148`) | 72 | **rewrite**, ~90 lines |

≈800 lines, of which ~620 is verbatim copy and **~180 genuinely new**. Add Gen2 and Gen3 (+520 more
verbatim lines) — it is free, and it is the difference between "works with my cube" and "works with
GAN cubes."

Do **not** vendor `gan-smart-timer.ts` (233 lines, unused) or `cubeTimestampLinearFit` /
`cubeTimestampCalcSkew` from `utils.ts` — [timeline.ts](packages/cube-link/src/timeline.ts) already
does that better and says so in its header.

MIT licensed. Attribute the vendored files in a header comment and in
[the cube-link README](packages/cube-link/README.md).

Dropping `aes-js` also deletes the lazy-import workaround documented in
[gan.ts](packages/cube-link/src/gan.ts) (lines 339–345: *"breaks Node's ESM loader, so a static
import would make this module unimportable in tests"*), making `gan.ts` statically importable under
vitest.

## Phases

Effort in the weekend units [PLAN.md](PLAN.md) uses. **P0–P2 need no phone, no Xcode and no Apple
account.**

### P0 — Purity and payload · 1 weekend · no device · **done**

- Move `scramble.ts` out of the engine barrel
  ([index.ts](packages/engine/src/index.ts) lines 65–73) to a `@cubing-companion/engine/scramble`
  subpath export; update the two consumers.
- Write `packages/planner/src/mlp.ts` — `scorerFrom(weights): ScoreFn`, ~50 lines. Add a JSON
  state-dict dump to [ml/export.py](ml/export.py) alongside the ONNX export. Delete
  `onnxruntime-web` and [model.ts](apps/web/workers/model.ts).
- Move `cross.fixture.json` and `pair.fixture.json` (256 real feature rows with PyTorch's exact
  outputs each) to `packages/planner/test/fixtures/` and assert parity to 1e-6. `checkParity` in
  [planner.worker.ts](apps/web/workers/planner.worker.ts) becomes a vitest case instead of a browser
  diagnostic.
- Add a web app manifest and icons.

**Shipped:** 27.8 MB of WASM gone from the planner path, no `fetch("/models/…")` to break under
`capacitor://localhost`, inference identical on web / Capacitor / Node — and Android gets an
installable PWA immediately.

As built, with two deviations from the plan above:

- **The parity check became a test, not a deleted feature.** `/selftest` is gone, replaced by
  [mlp.test.ts](packages/planner/test/mlp.test.ts), which runs the same 256 held-out fixture rows
  per head on every commit rather than when someone remembers to open a tab. Worst disagreement
  with PyTorch is 8.6e-7 (cross) and 6.0e-7 (pair) — float64 arithmetic disagreeing with float32,
  which is why the threshold is 1e-5 rather than the 1e-6 first planned.
- **ONNX export was kept**, redirected to `ml/out/` (gitignored) instead of being deleted. It is
  the portable form of a trained model and costs nothing to emit; it is simply no longer what the
  app runs, so the résumé line survives without the download.

Also added beyond the plan: [boundaries.test.ts](packages/engine/test/boundaries.test.ts), which
fails if anything but `scramble.ts` imports cubing.js's solver or if the barrel re-exports it —
the guard that stops the split silently regressing, since the symptom would otherwise appear on a
phone rather than in CI. And a worker test that ranks with the real bundled weights, so the wiring
from `weights.generated.ts` through `mlp.ts` to the worker is covered end to end without a browser.

### P1 — The BLE seam · 1 weekend · no device · **done**

- Define `BleTransport` / `BlePeripheral` / `BleAdvertisement` / `GanMacStore` in
  `packages/cube-link/src/ble/`.
- Implement `WebBluetoothTransport` in `src/ble/web.ts`.
- Record raw encrypted frames from the i Carry 4 in desktop Chrome and **commit the frame log as a
  fixture**.

**Shipped:** the seam, plus 40 tests over it and a boundary test that holds it in place. No
user-visible change beyond a diagnostic panel.

As built, with three deviations from the plan above:

- **Frame capture is its own module, not a flag on `GanDiagnosticRecorder`.**
  [capture.ts](packages/cube-link/src/ble/capture.ts) needs its own BLE connection — two owners of
  one GATT characteristic is not a thing — and its export has to contain the cube's MAC, because
  the frames are keyed from it. `diagnostics.ts` promises the opposite in its export allowlist, and
  a test asserts secrets never leak from it. Two contracts, kept apart rather than by weakening the
  one that made the promise.
- **The capture is passive**, so it records move frames and not facelet or hardware replies — those
  are answers to questions, and asking requires the encoder P2 builds. P2's differential test
  therefore covers the move path; the reply paths get covered on a device in P3.
- **`connectSmartCube` did not gain a transport option.** It would have been decoration: the
  library still does its own `requestDevice`, so there is nothing for an injected transport to do
  until P2 owns the connection. The option lands with the code that uses it.

`mac.ts` also came out larger than expected, and is where the port's platform risk concentrates —
see the table in the [package README](packages/cube-link/README.md). The short version: a reconnect
by device id yields no advertisement and therefore no decryption key, so the MAC store is load-
bearing rather than an optimisation.

#### What the capture proved

`gan-gen4-frames.json` — 1,213 frames, 136.9 s, `GANic4_580C`, MAC from advertisement, every frame
exactly 20 bytes. Before committing it, the frames were decrypted with the MAC-salted key using the
reference scheme, to answer the one question that decides whether the fixture is worth anything.

It decrypts, and not marginally:

| Check | Result |
|---|---|
| Event types | 1,063 MOVE, 138 FACELETS, 11 BATTERY, 1 unrecognised (`0x02`) |
| Invalid face encodings | **0 of 1,063** |
| Non-monotonic cube timestamps | **0** |
| Cube clock span vs host clock span | 133.1 s vs 133.1 s — **ratio 1.0003** |

The clock ratio is the decisive one. The cube's own 32-bit timestamps are recovered from the
decrypted payload; if the key were wrong they would be noise, and agreeing with the host clock to
0.03 % over two minutes is not something a wrong key produces.

Three findings that change P2's work:

- **Facelet reports arrive unprompted.** 138 of them, plus 11 battery reports. The plan assumed a
  passive capture would yield moves only, so the differential test covers more of the driver than
  expected. Only true request/response traffic — hardware info, move-history recovery, reset — is
  still out of reach until there is an encoder.
- **The move serial is 8-bit, in byte 6.** Byte 7 is zero across all 1,063 move frames. The
  reference driver reads a 16-bit little-endian word there, which works only because that high byte
  happens to be zero, and then masks with `& 0xFF` elsewhere. Read as 16-bit the stream shows 25
  sequence breaks; read as 8-bit, 21. The vendored driver should read 8 bits and say why.
- **21 genuine move gaps in 137 seconds**, about 2 %. These are moves the cube sent and the host
  never saw — exactly what the Gen4 move-history request exists to recover, and unrecoverable in a
  passive capture. Consistent with the 6.9 % null-timestamp figure in
  [GYRO_RESULTS.md](GYRO_RESULTS.md), and a reminder that P2's interpolation work has real data
  behind it.

`test/fixture.test.ts` asserts the fixture's integrity and replays it through `FakeTransport`. It
deliberately does not decrypt: this package cannot yet, and the phase ordering is the point. The
table above is what P2's differential test must reproduce.

### P2 — Vendor the protocol · 1 weekend · desktop Chrome only · **done**

- Port the table above into `packages/cube-link/src/gan/`, with the connection implementing the
  **unchanged** `GanConnectionLike`.
- Differential-test the vendored decoder against `gan-web-bluetooth` over the committed frames —
  same shape as [differential.test.ts](packages/engine/test/differential.test.ts).
- Add neighbour interpolation to `MoveTimeline.retime` with a distinct
  `timestampSource: "interpolated"`, so pause metrics can decline to trust a gap spanning one. Moves
  recovered via the Gen4 history path carry `cubeTimestamp: null` **and** `localTimestamp: null`,
  and get filtered out in [recorder.ts](packages/session/src/recorder.ts) — that is **6.9 % of
  recorded moves on desktop today** (see [GYRO_RESULTS.md](GYRO_RESULTS.md)), and longer iOS
  connection intervals will push it higher.
- Drop the `gan-web-bluetooth` dependency.

**Shipped:** a protocol decoder regression-tested in CI forever, and `gan-web-bluetooth`, `aes-js`
and `rxjs` all gone from the shipping bundle — verified by grepping the production build. Nothing
under `src/` imports the library, and a boundary test now fails if it comes back.

As built, with four deviations from the plan above:

- **The library is kept as a devDependency, not dropped.** The plan expected to delete it and let
  the differential test decay into a golden file. Keeping it costs nothing at runtime — it is not
  in the bundle, and the iOS blocker was its Web Bluetooth coupling, which a test-only dependency
  does not have — and it buys a live diff on every run instead of a frozen snapshot. `gan.ts` pins
  its version, so upgrading it fails the build and prompts a re-diff.
- **All three generations are vendored and tested, not just Gen4.** The drivers are pure
  `bytes → events`, so the differential test feeds random messages under each event type through
  both implementations. That covers Gen2 and Gen3 — cubes nobody here owns — better than the real
  capture covers Gen4, because a two-minute solve only exercises the messages that happened.
- **The vendored decoder is deliberately safer than the reference on malformed input.** The
  reference indexes its facelet maps with whatever arrived: random payloads make it either throw
  out of the notification handler or, worse, report a cube with duplicate edges and `NaN`
  orientations. Over BLE that is a corrupted packet, which is routine. `isCube` validates and the
  message is dropped. The differential test asserts equality where the reference is sane and
  asserts we decline where it is not, counting both so the divergence stays deliberate.
- **Notification handling is serialised.** Decoding awaits a write when it requests move history,
  and the reference calls it straight from the characteristic event, so two notifications arriving
  together interleave inside the move buffer — reordering exactly the moves already in trouble.

One finding worth recording: the reference reads the Gen4 move serial as a 16-bit little-endian
word, and the vendored driver copies that rather than switching to the 8-bit read the capture
implies. The high byte is zero across all 1,063 move frames and every comparison downstream masks
with `0xFF`, so the two agree — but the differential test only holds while that stays true, and the
comment in `gen4.ts` says so.

### P3 — First light on the phone · 1 weekend · **done, on device**

- `output: "export"` in [next.config.ts](apps/web/next.config.ts). Verify the
  `new Worker(new URL(…))` chunk in [usePlanner.ts](apps/web/components/usePlanner.ts) survives
  static export.
- `apps/mobile/` with Capacitor, iOS and Android platforms added.
- `CapacitorBleTransport` over `@capacitor-community/bluetooth-le`, with `GanMacStore` persistence.
- `NSBluetoothAlwaysUsageDescription` in Info.plist — **mandatory since iOS 13; without it the app
  crashes on the first Core Bluetooth call** rather than failing gracefully. Do *not* declare the
  `bluetooth-central` background mode.
- Android: `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` runtime requests, plus `BLUETOOTH`,
  `BLUETOOTH_ADMIN` and `ACCESS_FINE_LOCATION` with `android:maxSdkVersion="30"`.
- Install to the iPhone with **free personal-team provisioning** — no $99 required.
- Update the "No iOS" lines in [PLAN.md](PLAN.md) and the browser-support note in
  [README.md](README.md).

**Ships:** the stated blocker is gone.

### P4 — Make it a phone app · 2 weekends · device for half · **done**

- `SqliteSolveStore` over `@capacitor-community/sqlite`, implementing `SolveStore`. The existing
  contract test in `packages/session/test/store.test.ts` covers it for free.
- Keep-awake via `@capacitor-community/keep-awake`, acquired and released off `RecorderState.phase`
  so it cannot leak.
- Reconnect-on-resume using the MAC cache. iOS suspends a backgrounded app within seconds and drops
  the BLE connection.
- Replace the `window.prompt` MAC fallback with a proper sheet — largely vestigial once native
  scanning works.
- Mobile-first information architecture rework (below).

### P5 — Meet the latency budget · 1 weekend · half headless · **done**

- Add `deadlineMs` to `SearchOptions` in [types.ts](packages/solver/src/types.ts), checked every
  ~4096 nodes. Keep `maxNodes` as the reproducible-benchmark path. Node budgets are
  device-independent in *work* and wildly device-dependent in *time* — exactly wrong when device
  speed varies 5×.
- Device speed calibration: time the startup cross-table build, set
  `speedFactor = referenceBuildMs / measuredBuildMs`, scale `maxNodes` when no deadline is given.
- Push the yield in [planner.worker.ts](apps/web/workers/planner.worker.ts) down from per-colour into
  the per-slot loop. At 4–8 s per sweep on mid-range Android, one colour is ~700 ms of unbroken work
  — long enough that a cancelled request keeps burning battery.
- **The product fix, and the biggest single win:** default the sweep to a preferred cross-colour set
  from Settings, with "sweep all colours" as an explicit action. Colour-neutrality is 6/7 of the
  cost; this takes the median from ~1.9 s to ~300 ms before any engineering. It is also better UX —
  a colour-neutral solver wants the comparison, a white-cross solver wants the answer.
- *Optional:* the six per-colour cross tables are isomorphic under cube rotation. Building one and
  indexing the other five through a rotation would save ~415 ms of cold start and 1.6 MB resident.
  Only do this behind a test asserting `crossDistance(s, f) === crossDistanceViaRotation(s, f)` over
  a few thousand random states — deriving the index permutation is where the bugs live.

**Shipped**, and the measurement reordered the work. What the plan listed as one item among five —
defaulting the sweep to a preferred cross colour — turned out to be the entire fix:

| | Before | After |
|---|---:|---:|
| Cold table build | 2,208 ms | ~370 ms (one table, not six) |
| Time to a usable answer | 5.45 s | **~966 ms** |

Three deviations, all downstream of that:

- **The single-table-plus-rotation optimisation was dropped, not deferred.** Its entire value was
  saving five of six table builds. Sweeping one colour builds one table, so the saving collapses to
  nothing — and deriving the index permutation was the riskiest change in the phase.
- **Device speed calibration was dropped, superseded by `deadlineMs`.** The plan proposed timing
  the startup table build and scaling `maxNodes` by the result. That is an indirect way of saying
  "take about this long"; a deadline says it directly. Two mechanisms for one goal is worse than
  one, so `SearchOptions` gained `deadlineMs` — sampled every 4,096 nodes, because reading the
  clock per node costs more than the node it guards — and `maxNodes` stays as the reproducible
  path a benchmark needs.
- **Finer yielding was not done.** With one colour the sweep is ~1 s of work in a worker, off the
  main thread, and the deadline caps a pathological position at 2.5 s per colour. Making
  `planColour` yield would mean threading async plumbing through a pure package for a problem the
  colour default already removed.

Also added: a **planner benchmark** in Settings that runs a fixed workload, so any device can be
compared against the numbers above rather than against a claim. The desktop reference it compares
to was measured with that same workload, not taken from the ~490 ms / 1.9 s figures quoted
elsewhere in the codebase — those came from a different position and a different runtime, and
comparing against them would have compared two things that were never the same measurement.

**Total ≈ 6–7 weekends**, three of which need nothing not already on hand.

## Mobile information architecture (P4)

The desktop grid in [CubeHarness.tsx](apps/web/components/CubeHarness.tsx) already collapses to one
column, so the phone today is *legible but wrong* — an IA problem, not a CSS one. The one-handed
rule: every primary action lives in the bottom third, which the current button row violates.

**Solve** (default tab) — full-bleed [TwistyPlayer](apps/web/components/TwistyPlayer.tsx) at ~40 % of
viewport, scramble and status beneath. One primary button in a fixed bottom bar whose label follows
`RecorderState.phase`: Connect → Scramble → armed → solving (big timer, everything else hidden) →
Save / Discard. Sync, "Cube is solved" and Disconnect move behind an overflow.
[MoveLog](apps/web/components/MoveLog.tsx) and
[GyroDiagnostics](apps/web/components/GyroDiagnostics.tsx) move to Settings. Screen stays awake on
this tab only.

**Plan is a bottom sheet over Solve, not a tab** — it is contextual to the current scramble and read
while holding the cube. Peek state is one line: *"White cross · green front · 6 moves."* Drag up for
[PlannerPanel](apps/web/components/PlannerPanel.tsx)'s content, restructured as a horizontal row of
six colour chips with move counts, one colour expanded at a time. Practice mode becomes the
**default** interaction on mobile — plan-in-inspection-then-reveal is phone-native and a desktop
afterthought.

**History** — [SolveList](apps/web/components/SolveList.tsx) as the list.
[SolveDetail](apps/web/components/SolveDetail.tsx) stops being a modal and becomes a pushed
full-screen route with its own scroll; modals fight the system back gesture and clip at 677 lines of
content. Sticky cube and scrubber at the top (~35 %), then a segmented control over three panes:

- **Phases** — `PhaseTable` as a vertical stack of tappable cards, each jumping the scrubber to that
  phase. Rows of numbers do not survive 390 px.
- **Score** — `ScorePanel`, already vertical, mostly as-is.
- **Pro line** — [DiffPanel](apps/web/components/DiffPanel.tsx) as one card per decision, each with
  *Play mine* / *Play theirs*. Branch playback is **better** on a phone, because the cube is in your
  hand.

Horizontal drag on the cube scrubs; tap plays and pauses.

**Settings** — paired cube and MAC cache, preferred cross colours (drives P5), planner effort,
manual and keyboard input (a desktop feature currently eating phone real estate), diagnostics, JSON
export and import.

## Risks and failure matrix

| Risk | Assessment and mitigation |
|---|---|
| **BLE timing corrupts TPS / pause metrics** | **Mostly safe.** iOS enforces a 15 ms minimum connection interval; Android negotiates to ~11.25 ms. Longer intervals batch more moves per notification. [MoveTimeline](packages/cube-link/src/timeline.ts) takes the cube's own clock as per-move truth and least-squares fits it onto host time, and every TPS, pause and phase duration is a *difference* of fitted cube timestamps. Batching changes how many anchors the fit has, not the relative spacing; with 64 anchors, losing half barely moves it. What is *not* insulated is the null-timestamp path — hence the P2 interpolation work. |
| **Android `neverForLocation` strips manufacturer data** | `android:usesPermissionFlags="neverForLocation"` on `BLUETOOTH_SCAN` skips location permission on Android 12+, but the platform then filters location-derivable scan results, and beacon libraries report manufacturer data being stripped. GAN's CIC payload is not iBeacon-shaped so it will probably survive — **test explicitly on an Android 12+ device**. If manufacturer data comes back empty, drop the flag and request `ACCESS_FINE_LOCATION`. Leave a comment explaining the choice, because the next reader will "clean it up." |
| **Android ≤ 30 scans return nothing, silently** | Scanning needs location permission granted *and* system location services switched on. Detect both and message them explicitly rather than showing an empty device list. |
| **WKWebView evicts IndexedDB** | Script-writable storage is subject to ITP's 7-day eviction for non-app-bound domains and to storage-pressure purging, and treatment of the `capacitor://localhost` custom scheme has shifted across iOS releases. **Treat IndexedDB as a cache.** `SqliteSolveStore` (P4) writes to the app container. Ship JSON export/import regardless — one screen, and the honest answer to "my phone died." |
| **Free provisioning expires after 7 days** | Personal-team builds must be reinstalled from Xcode weekly. For daily use that gets old fast, and the $99/yr Apple Developer Program is the only fix. Nothing in this plan depends on it — validate the P3 BLE spike before deciding. |
| **Scramble quality silently degrades** | [scramble.ts](packages/engine/src/scramble.ts) notes that Turbopack currently fails cubing.js's worker instantiation, so the app may already be falling back to random-move scrambles. WKWebView supports Workers and WebAssembly, so a static export may produce *better* scrambles on mobile than in dev. `generateScramble` already reports `kind` — surface it in the UI and check which one is actually being produced, on each platform. |
| **App Store Guideline 4.2** | **Does not apply** at the chosen distribution target. If that changes, the defence is strong: native Core Bluetooth for a hardware accessory, fully offline, local storage. The key move would be App Review Notes pointing the reviewer at manual-input mode, since they will not own a GAN cube. |

## Boundary enforcement

[boundaries.test.ts](packages/analysis/test/boundaries.test.ts) is the model — source-reading, no
tooling, fails loudly. Add three in the same style:

1. `packages/cube-link/test/boundaries.test.ts` — no file under `src/` mentions `navigator` except
   `src/ble/web.ts`; nothing imports `@capacitor/*` except `src/ble/capacitor.ts`; nothing under
   `src/gan/` imports outside `src/gan/` and `src/ble/transport.ts`. The last one keeps the vendored
   protocol honest.
2. `packages/engine/test/boundaries.test.ts` — no file under `src/` imports anything external except
   `cubing/alg`, with `scramble.ts` the sole exception. Prevents finding 3 from regressing.
3. Root `test/boundaries.test.ts` — `apps/mobile` contains no `.tsx`; nothing outside
   [apps/web](apps/web) imports from it.

## Verification

### Headless, per phase

Root `npm test` — [vitest.config.ts](vitest.config.ts) already includes `apps/*/test/**`.

- **P0** — `packages/planner/test/mlp.test.ts` against the existing 256-row PyTorch fixtures to
  1e-6. Confirm no `.wasm` under `apps/web/.next/static/media/` after `npm run build`.
- **P1** — `packages/cube-link/test/transport.test.ts` with `FakeTransport` replaying the committed
  frame log.
- **P2** — `packages/cube-link/test/gan-differential.test.ts`: vendored decoder against
  `gan-web-bluetooth` over identical frames, asserting identical event streams. Extend
  [timeline.test.ts](packages/cube-link/test/timeline.test.ts) with synthetic batched streams at
  0 %, 10 % and 30 % null timestamps, asserting fitted TPS stays in tolerance. **This is the "does
  iOS batching break my metrics" test, and it needs no iOS.**
- **P4** — extend the existing `packages/session/test/store.test.ts` contract suite to
  `SqliteSolveStore` behind an availability guard.
- **P5** — a benchmark asserting a `deadlineMs`-bounded sweep returns within tolerance, and that the
  first colour still posts in ~150 ms.

Throughout: `npm test`, `npm run typecheck`, and the three new boundary tests must pass.

### On device, P3 onward

1. `npm run build -w @cubing-companion/web && npx cap sync`, then run to a physical iPhone from
   Xcode with free provisioning.
2. Connect the i Carry 4. Confirm the MAC is recovered from scan manufacturer data with **no
   prompt**, then force-quit, reopen, and confirm reconnect works from the cached MAC with no scan.
3. Scramble, solve, verify the twisty player tracks, the solve saves, and phase segmentation matches
   what the same scramble produces in desktop Chrome.
4. Compare TPS and pause metrics for the same replayed move stream on desktop and on iOS — the
   direct check on the connection-interval concern.
5. Time a colour-neutral sweep and the cross-table build on both devices. Record the numbers; set the
   P5 budgets from them.
6. Repeat 1–5 on an Android 12+ device, specifically checking that manufacturer data survives the
   `neverForLocation` flag.
7. Leave the app backgrounded for 10 minutes, reopen mid-session, confirm reconnect-on-resume and
   that no solve record is lost.

**What stays untestable without hardware:** `src/ble/web.ts` and `src/ble/capacitor.ts` — two thin
files of pure I/O. That is the right place for it, and shrinking the untestable surface to those two
files is what the whole refactor is for.

## Recommended first implementation change

P0 and P1 together. Deleting 27.8 MB of ONNX runtime and introducing `BleTransport` are both wins
regardless of which mobile path is eventually taken, neither needs a phone, a Mac toolchain or an
Apple account, and together they turn "add iOS" from a rewrite into a shell.
