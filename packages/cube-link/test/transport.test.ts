/**
 * The transport seam, and the capture that runs on it.
 *
 * All of this is exercised through {@link FakeTransport}, which is the argument for having a seam
 * at all: connection, service resolution, MAC recovery, subscription, framing, limits and teardown
 * are covered on a machine with no Bluetooth. What is left untested here is `web.ts` — a thin
 * translation layer over the browser's API — and that is the right thing to be left.
 */
import { describe, expect, it } from "vitest";
import {
  captureProtocolFrames,
  framesToBytes,
  type ProtocolCapture,
} from "../src/ble/capture.ts";
import { fakeAdvertisement, FakeTransport, type FakeFrame } from "../src/ble/fake.ts";
import { GAN_COMPANY_IDS, GAN_SERVICES, profileFor } from "../src/ble/gan-uuids.ts";
import { MemoryMacStore } from "../src/ble/transport.ts";

const GEN4 = GAN_SERVICES.find((profile) => profile.protocol === "gen4")!;
const MAC = "AB:CD:EF:01:23:45";

function frames(count: number, startAt = 0, step = 50): FakeFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: startAt + i * step,
    service: GEN4.service,
    characteristic: GEN4.stateCharacteristic,
    // Distinguishable per frame, so ordering failures are visible rather than plausible.
    data: new Uint8Array([0x00, i & 0xff, 0xff]),
  }));
}

function transportWith(overrides: Partial<ConstructorParameters<typeof FakeTransport>[0]> = {}) {
  return new FakeTransport({
    services: [GEN4.service],
    advertisement: fakeAdvertisement(MAC),
    clock: { mode: "manual" },
    ...overrides,
  });
}

describe("GAN service profiles", () => {
  it("identifies a generation from the services a cube exposes", () => {
    expect(profileFor([GEN4.service])?.protocol).toBe("gen4");
    expect(profileFor(["6e400001-b5a3-f393-e0a9-e50e24dc4179"])?.protocol).toBe("gen2");
  });

  it("is case-insensitive, because platforms disagree about UUID case", () => {
    expect(profileFor([GEN4.service.toUpperCase()])?.protocol).toBe("gen4");
  });

  it("returns null for a device that is not a GAN cube", () => {
    expect(profileFor(["0000180f-0000-1000-8000-00805f9b34fb"])).toBeNull();
  });
});

describe("discovery", () => {
  it("asks for every GAN service, name prefix and company code", async () => {
    const transport = transportWith();
    const session = await captureProtocolFrames(transport);

    expect(transport.lastFilter!.namePrefixes).toContain("GAN");
    expect(transport.lastFilter!.optionalServices).toEqual(
      GAN_SERVICES.map((profile) => profile.service),
    );
    // All 256: which one a cube uses is unpredictable, and a platform only surfaces the ones asked
    // for — miss them and the MAC becomes unreadable on exactly the platforms that need it most.
    expect(transport.lastFilter!.manufacturerCompanyIds).toHaveLength(256);
    expect(transport.lastFilter!.manufacturerCompanyIds).toEqual(GAN_COMPANY_IDS);
    session.stop();
  });

  it("refuses a device with no known GAN service, and hangs up", async () => {
    const transport = transportWith({ services: ["0000180f-0000-1000-8000-00805f9b34fb"] });
    await expect(captureProtocolFrames(transport)).rejects.toThrow(/unsupported/);
    // The connection must not be left open behind the failure.
    await expect(transport.peripherals[0]!.services()).rejects.toThrow(/disconnected/);
  });

  it("refuses when the MAC cannot be recovered, and hangs up", async () => {
    const transport = transportWith({ advertisement: null });
    await expect(captureProtocolFrames(transport)).rejects.toThrow(/MAC address/);
    await expect(transport.peripherals[0]!.services()).rejects.toThrow(/disconnected/);
  });

  it("reports an unavailable radio rather than pretending to scan", async () => {
    const transport = transportWith({ available: false });
    await expect(captureProtocolFrames(transport)).rejects.toThrow(/unavailable/);
  });
});

describe("capturing frames", () => {
  it("records what arrives, in order, with arrival times", async () => {
    const transport = transportWith({ frames: frames(3) });
    const session = await captureProtocolFrames(transport, { now: () => 0 });
    transport.peripherals[0]!.flush();

    const capture = session.export();
    expect(capture.frames.map((frame) => frame.hex)).toEqual(["0000ff", "0001ff", "0002ff"]);
    expect(capture.frames.map((frame) => frame.atMs)).toEqual([0, 50, 100]);
  });

  it("subscribes to the state characteristic of the generation it found", async () => {
    const transport = transportWith({ frames: frames(1) });
    const session = await captureProtocolFrames(transport);
    transport.peripherals[0]!.flush();

    const capture = session.export();
    expect(capture.protocol).toBe("gen4");
    expect(capture.service).toBe(GEN4.service);
    expect(capture.stateCharacteristic).toBe(GEN4.stateCharacteristic);
    expect(capture.frames).toHaveLength(1);
  });

  it("carries the MAC, because the frames are undecryptable without it", async () => {
    const transport = transportWith({ frames: frames(1) });
    const session = await captureProtocolFrames(transport);
    const capture = session.export();
    expect(capture.mac).toBe(MAC);
    expect(capture.macSource).toBe("advertisement");
  });

  it("records where the MAC came from, so a capture that may not decrypt says so", async () => {
    const store = new MemoryMacStore();
    await store.set("fake-device", MAC);
    const transport = transportWith({ advertisement: null });
    const session = await captureProtocolFrames(transport, { store });
    expect(session.export().macSource).toBe("stored");
  });

  it("summarises what it has without stopping", async () => {
    const transport = transportWith({ frames: frames(4) });
    const session = await captureProtocolFrames(transport, { now: () => 0 });
    transport.peripherals[0]!.deliver(2);

    const summary = session.summary();
    expect(summary.state).toBe("recording");
    expect(summary.frames).toBe(2);
    expect(summary.bytes).toBe(6);
    expect(summary.frameSizes).toEqual([3]);
    session.stop();
    expect(session.summary().state).toBe("stopped");
    expect(session.summary().stopReason).toBe("manual");
  });
});

describe("bounds", () => {
  it("stops at the frame limit rather than growing without end", async () => {
    const transport = transportWith({ frames: frames(10) });
    const session = await captureProtocolFrames(transport, { maxFrames: 3, now: () => 0 });
    transport.peripherals[0]!.flush();

    expect(session.export().frames).toHaveLength(3);
    expect(session.summary().stopReason).toBe("frame-limit");
  });

  it("stops at the duration limit, and does not keep the frame that crossed it", async () => {
    const transport = transportWith({ frames: frames(10, 0, 100) });
    const session = await captureProtocolFrames(transport, { maxDurationMs: 250, now: () => 0 });
    transport.peripherals[0]!.flush();

    expect(session.export().frames.map((frame) => frame.atMs)).toEqual([0, 100, 200]);
    expect(session.summary().stopReason).toBe("duration-limit");
  });

  it("ignores anything that arrives after it stopped", async () => {
    const transport = transportWith({ frames: frames(4) });
    const session = await captureProtocolFrames(transport, { now: () => 0 });
    transport.peripherals[0]!.deliver(1);
    session.stop();
    transport.peripherals[0]!.flush();
    expect(session.export().frames).toHaveLength(1);
  });

  it("keeps the first stop reason when stopped twice", async () => {
    const transport = transportWith({ frames: frames(1) });
    const session = await captureProtocolFrames(transport);
    session.stop("manual");
    session.stop("duration-limit");
    expect(session.summary().stopReason).toBe("manual");
  });
});

describe("teardown", () => {
  it("disconnects the cube when the capture is stopped", async () => {
    const transport = transportWith({ frames: frames(1) });
    const session = await captureProtocolFrames(transport);
    session.stop();
    await expect(transport.peripherals[0]!.services()).rejects.toThrow(/disconnected/);
  });

  it("ends the capture when the cube disappears, without trying to hang up on it", async () => {
    const transport = transportWith({ frames: frames(4) });
    const session = await captureProtocolFrames(transport, { now: () => 0 });
    transport.peripherals[0]!.deliver(1);
    transport.peripherals[0]!.dropConnection();

    expect(session.summary().stopReason).toBe("disconnected");
    expect(session.export().frames).toHaveLength(1);
  });
});

describe("replaying a capture", () => {
  it("round-trips frames back to the bytes that were recorded", async () => {
    const transport = transportWith({ frames: frames(3) });
    const session = await captureProtocolFrames(transport, { now: () => 0 });
    transport.peripherals[0]!.flush();

    const bytes = framesToBytes(session.export());
    expect(bytes).toHaveLength(3);
    expect([...bytes[1]!]).toEqual([0x00, 0x01, 0xff]);
  });

  it("feeds a recorded capture straight back into a fake transport", async () => {
    // This is what a vendored protocol driver will be tested against: real bytes, no radio.
    const original = transportWith({ frames: frames(3) });
    const session = await captureProtocolFrames(original, { now: () => 0 });
    original.peripherals[0]!.flush();
    const capture = session.export();

    const replay = new FakeTransport({
      services: [capture.service],
      advertisement: fakeAdvertisement(capture.mac),
      clock: { mode: "manual" },
      frames: framesToBytes(capture).map((data, i) => ({
        atMs: capture.frames[i]!.atMs,
        service: capture.service,
        characteristic: capture.stateCharacteristic,
        data,
      })),
    });
    const second = await captureProtocolFrames(replay, { now: () => 0 });
    replay.peripherals[0]!.flush();

    expect(second.export().frames).toEqual(capture.frames);
  });

  it("rejects a capture whose frames are not hex", () => {
    const broken = {
      frames: [{ atMs: 0, hex: "zz" }],
    } as unknown as ProtocolCapture;
    expect(() => framesToBytes(broken)).toThrow(/valid hex/);
  });
});

describe("writes", () => {
  it("records what was sent to the cube, for when commands exist to send", async () => {
    const transport = transportWith();
    const session = await captureProtocolFrames(transport);
    const peripheral = transport.peripherals[0]!;
    await peripheral.write(GEN4.service, GEN4.commandCharacteristic, new Uint8Array([1, 2, 3]));

    expect(peripheral.writes).toHaveLength(1);
    expect([...peripheral.writes[0]!.data]).toEqual([1, 2, 3]);
    session.stop();
  });

  it("copies what it was given, so a reused buffer cannot rewrite history", async () => {
    const transport = transportWith();
    const session = await captureProtocolFrames(transport);
    const peripheral = transport.peripherals[0]!;
    const buffer = new Uint8Array([1, 2, 3]);
    await peripheral.write(GEN4.service, GEN4.commandCharacteristic, buffer);
    buffer[0] = 0xff;

    expect([...peripheral.writes[0]!.data]).toEqual([1, 2, 3]);
    session.stop();
  });
});
