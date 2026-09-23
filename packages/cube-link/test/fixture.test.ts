/**
 * The recorded cube, as a fixture.
 *
 * `gan-gen4-frames.json` is 137 seconds of a real GAN i Carry 4 talking to desktop Chrome on
 * 22 September 2026 — 1,213 encrypted frames, captured before anything in this repository could
 * decode them. It is what the vendored protocol driver gets built and regression-tested against,
 * so it is checked for integrity here: a fixture that has quietly changed shape would make the
 * driver's tests meaningless rather than failing.
 *
 * The frames decrypt. That was verified before committing them, using the MAC-salted key and the
 * reference implementation's scheme, and the numbers are recorded in `MOBILE_PLAN.md` as the
 * targets the vendored decoder has to reproduce. Decoding is deliberately not done here — this
 * package cannot yet decrypt anything, and that is the point of the phase ordering.
 */
import { describe, expect, it } from "vitest";
import capture from "./fixtures/gan-gen4-frames.json" with { type: "json" };
import { framesToBytes, type ProtocolCapture } from "../src/ble/capture.ts";
import { fakeAdvertisement, FakeTransport } from "../src/ble/fake.ts";
import { captureProtocolFrames } from "../src/ble/capture.ts";
import { GAN_SERVICES, profileFor } from "../src/ble/gan-uuids.ts";
import { isValidMac } from "../src/ble/mac.ts";

const fixture = capture as ProtocolCapture;

describe("the recorded Gen4 capture", () => {
  it("is the format this package writes", () => {
    expect(fixture.format).toBe("cubing-companion.gan-protocol-capture");
    expect(fixture.schemaVersion).toBe(1);
  });

  it("came from a cube we can identify", () => {
    expect(fixture.protocol).toBe("gen4");
    expect(fixture.deviceName).toBe("GANic4_580C");
    // The i Carry 4 — the cube GYRO_RESULTS.md identified, which has no gyroscope.
    expect(profileFor([fixture.service])?.protocol).toBe("gen4");
    expect(fixture.stateCharacteristic).toBe(
      GAN_SERVICES.find((profile) => profile.protocol === "gen4")!.stateCharacteristic,
    );
  });

  it("carries a MAC recovered from an advertisement", () => {
    // Anything else and the frames might not decrypt — which is why the source is recorded.
    expect(fixture.macSource).toBe("advertisement");
    expect(isValidMac(fixture.mac)).toBe(true);
  });

  it("is the length and shape it was recorded at", () => {
    expect(fixture.frames).toHaveLength(1213);
    expect(fixture.durationMs).toBeCloseTo(136851.6, 0);
    expect(fixture.stopReason).toBe("manual");
  });

  it("is every frame exactly 20 bytes", () => {
    // Gen4 state notifications are fixed-width. A different width would mean a different
    // protocol, and the driver's framing assumptions would be wrong.
    const widths = new Set(fixture.frames.map((frame) => frame.hex.length / 2));
    expect([...widths]).toEqual([20]);
  });

  it("is ordered by arrival, with no time going backwards", () => {
    for (let i = 1; i < fixture.frames.length; i++) {
      expect(fixture.frames[i]!.atMs).toBeGreaterThanOrEqual(fixture.frames[i - 1]!.atMs);
    }
  });

  it("parses back to bytes", () => {
    const bytes = framesToBytes(fixture);
    expect(bytes).toHaveLength(fixture.frames.length);
    expect(bytes.every((frame) => frame.byteLength === 20)).toBe(true);
  });

  it("holds mostly distinct frames", () => {
    // Under a fixed key and IV, identical ciphertext means identical plaintext. A handful repeat
    // — the cube's roughly 1 Hz idle heartbeat — but a capture that was mostly repeats would be
    // a capture of a cube nobody turned.
    const distinct = new Set(fixture.frames.map((frame) => frame.hex));
    expect(distinct.size).toBeGreaterThan(fixture.frames.length * 0.95);
  });
});

describe("replaying the capture", () => {
  it("feeds back through a fake transport frame for frame", async () => {
    // The thing the whole seam was built for: a real cube's bytes, delivered to code under test,
    // on a machine with no Bluetooth.
    const transport = new FakeTransport({
      services: [fixture.service],
      advertisement: fakeAdvertisement(fixture.mac),
      clock: { mode: "manual" },
      frames: framesToBytes(fixture).map((data, i) => ({
        atMs: fixture.frames[i]!.atMs,
        service: fixture.service,
        characteristic: fixture.stateCharacteristic,
        data,
      })),
    });

    const session = await captureProtocolFrames(transport, {
      now: () => 0,
      maxFrames: 100_000,
      maxDurationMs: 10 ** 7,
    });
    transport.peripherals[0]!.flush();

    const replayed = session.export();
    expect(replayed.frames).toEqual(fixture.frames);
    expect(replayed.protocol).toBe("gen4");
  });
});
