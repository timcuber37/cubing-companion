/**
 * The native transport, without a phone.
 *
 * `ble/capacitor.ts` is thin by design — it translates between the plugin's shapes and the
 * transport interface — but the translation is where the MAC lives, and the MAC decides whether
 * anything the cube says can be read at all. So the parts worth testing are: does an
 * advertisement's manufacturer data survive the trip, does scanning prefer the sighting that
 * carries it, and does a cube get chosen sensibly.
 *
 * What is left for the device is the plugin itself. That is the right place for the untestable
 * surface to be, and it is two files wide across both platforms.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CapacitorBleTransport,
  type BleClientLike,
  type DiscoveredDevice,
  type ScanResultLike,
} from "../src/ble/capacitor.ts";
import { GAN_COMPANY_IDS, GAN_NAME_PREFIXES, GAN_SERVICES } from "../src/ble/gan-uuids.ts";
import { macFromAdvertisement } from "../src/ble/mac.ts";
import type { BleScanFilter } from "../src/ble/transport.ts";

const GEN4 = GAN_SERVICES.find((profile) => profile.protocol === "gen4")!;
const MAC = "AB:CD:EF:01:23:45";

const FILTER: BleScanFilter = {
  namePrefixes: GAN_NAME_PREFIXES,
  optionalServices: GAN_SERVICES.map((profile) => profile.service),
  manufacturerCompanyIds: GAN_COMPANY_IDS,
};

/** Manufacturer payload carrying `mac`, least significant byte first, as it goes over the air. */
function payload(mac: string): DataView {
  const bytes = mac.split(":").map((part) => Number.parseInt(part, 16)).reverse();
  return new DataView(Uint8Array.from([0x00, 0x00, 0x00, ...bytes]).buffer);
}

function scanResult(overrides: Partial<ScanResultLike> = {}): ScanResultLike {
  return {
    device: { deviceId: "device-1", name: "GANic4_580C" },
    localName: "GANic4_580C",
    rssi: -55,
    manufacturerData: { "1": payload(MAC) },
    uuids: [GEN4.service],
    ...overrides,
  };
}

/** A stand-in for the plugin. Replays scan results, records what was asked of it. */
function fakeClient(results: ScanResultLike[], overrides: Partial<BleClientLike> = {}) {
  const calls = { initialize: 0, connect: [] as string[], stopScan: 0, notifications: 0 };
  let onDisconnect: ((deviceId: string) => void) | undefined;
  let notify: ((value: DataView) => void) | undefined;

  const client: BleClientLike = {
    async initialize() {
      calls.initialize++;
    },
    async isEnabled() {
      return true;
    },
    async requestLEScan(_options, callback) {
      for (const result of results) callback(result);
    },
    async stopLEScan() {
      calls.stopScan++;
    },
    async connect(deviceId, handler) {
      calls.connect.push(deviceId);
      onDisconnect = handler;
    },
    async disconnect() {},
    async getServices() {
      return [{ uuid: GEN4.service }];
    },
    async write() {},
    async startNotifications(_d, _s, _c, callback) {
      calls.notifications++;
      notify = callback;
    },
    async stopNotifications() {},
    ...overrides,
  };

  return {
    client,
    calls,
    drop: () => onDisconnect?.("device-1"),
    send: (bytes: number[]) => notify?.(new DataView(Uint8Array.from(bytes).buffer)),
  };
}

const transport = (fake: { client: BleClientLike }, options = {}) =>
  new CapacitorBleTransport(fake.client, { scanMs: 50, ...options });

describe("discovery", () => {
  it("carries the advertisement through, so the MAC survives", async () => {
    // The whole reason this transport scans instead of using the plugin's device picker.
    const fake = fakeClient([scanResult()]);
    const { advertisement } = await transport(fake).requestDevice(FILTER);

    expect(advertisement).not.toBeNull();
    expect(macFromAdvertisement(advertisement!)).toBe(MAC);
  });

  it("parses the plugin's string company codes back to numbers", async () => {
    // The plugin keys manufacturer data by a decimal string; the interface uses numbers, and
    // `macFromAdvertisement` looks up GAN's 256 codes numerically.
    const fake = fakeClient([scanResult({ manufacturerData: { "65281": payload(MAC) } })]);
    const { advertisement } = await transport(fake).requestDevice(FILTER);
    expect(advertisement!.manufacturerData.has(0xff01)).toBe(true);
    expect(macFromAdvertisement(advertisement!)).toBe(MAC);
  });

  it("connects to the device it chose", async () => {
    const fake = fakeClient([scanResult()]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);
    expect(fake.calls.connect).toEqual(["device-1"]);
    expect(peripheral.deviceId).toBe("device-1");
    expect(peripheral.name).toBe("GANic4_580C");
  });

  it("always stops the scan, including when nothing was found", async () => {
    // A scan left running is a battery drain the user cannot see.
    const fake = fakeClient([]);
    await expect(transport(fake).requestDevice(FILTER)).rejects.toThrow(/No smart cube/);
    expect(fake.calls.stopScan).toBe(1);
  });

  it("ignores devices that are not cubes", async () => {
    const fake = fakeClient([
      scanResult({ device: { deviceId: "watch" }, localName: "Fitness Watch", uuids: [] }),
    ]);
    await expect(transport(fake).requestDevice(FILTER)).rejects.toThrow(/No smart cube/);
  });

  it("recognises a cube by its service when it advertises no name", async () => {
    // Built without `localName` at all rather than set to undefined: the cube simply does not
    // put its name in this advertisement, and it must still be recognised by its service.
    const quiet: ScanResultLike = {
      device: { deviceId: "quiet" },
      rssi: -55,
      manufacturerData: { "1": payload(MAC) },
      uuids: [GEN4.service],
    };
    const fake = fakeClient([quiet]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);
    expect(peripheral.deviceId).toBe("quiet");
  });
});

describe("choosing between cubes", () => {
  it("prefers a sighting that carries manufacturer data over a stronger one that does not", async () => {
    // Advertisements vary: the same cube may broadcast without manufacturer data. Taking the
    // loudest sighting blindly can therefore discard the only copy of the address.
    const fake = fakeClient([
      scanResult({ rssi: -30, manufacturerData: {} }),
      scanResult({ rssi: -80 }),
    ]);
    const { advertisement } = await transport(fake).requestDevice(FILTER);
    expect(macFromAdvertisement(advertisement!)).toBe(MAC);
  });

  it("takes the strongest signal when there is nothing to choose on", async () => {
    // No system chooser on native, so this is the default: the cube in your hand is louder than
    // the cube across the room.
    const fake = fakeClient([
      scanResult({ device: { deviceId: "far" }, rssi: -90 }),
      scanResult({ device: { deviceId: "near" }, rssi: -40 }),
    ]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);
    expect(peripheral.deviceId).toBe("near");
  });

  it("asks, when asked to ask", async () => {
    const fake = fakeClient([
      scanResult({ device: { deviceId: "far" }, rssi: -90 }),
      scanResult({ device: { deviceId: "near" }, rssi: -40 }),
    ]);
    const chooseDevice = vi.fn(async (devices: readonly DiscoveredDevice[]) =>
      devices.find((device) => device.deviceId === "far")!,
    );
    const { peripheral } = await transport(fake, { chooseDevice }).requestDevice(FILTER);

    expect(peripheral.deviceId).toBe("far");
    expect(chooseDevice.mock.calls[0]![0]).toHaveLength(2);
  });

  it("reports which candidates could actually be decrypted", async () => {
    // So a chooser can warn about a cube whose address was never seen, rather than connecting to
    // it and producing noise.
    const fake = fakeClient([
      scanResult({ device: { deviceId: "with" } }),
      scanResult({ device: { deviceId: "without" }, manufacturerData: {} }),
    ]);
    let offered: readonly DiscoveredDevice[] = [];
    await transport(fake, {
      chooseDevice: async (devices: readonly DiscoveredDevice[]) => {
        offered = devices;
        return devices[0]!;
      },
    }).requestDevice(FILTER);

    expect(offered.find((device) => device.deviceId === "with")!.hasManufacturerData).toBe(true);
    expect(offered.find((device) => device.deviceId === "without")!.hasManufacturerData).toBe(false);
  });

  it("aborts when the chooser declines", async () => {
    const fake = fakeClient([scanResult()]);
    await expect(
      transport(fake, { chooseDevice: async () => null }).requestDevice(FILTER),
    ).rejects.toThrow(/No cube was chosen/);
    expect(fake.calls.connect).toEqual([]);
  });
});

describe("the connected peripheral", () => {
  it("delivers notifications as bytes", async () => {
    const fake = fakeClient([scanResult()]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);

    const received: Uint8Array[] = [];
    await peripheral.subscribe(GEN4.service, GEN4.stateCharacteristic, (data) =>
      received.push(data),
    );
    fake.send([0x01, 0x02, 0x03]);

    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([0x01, 0x02, 0x03]);
  });

  it("sends only the bytes it was given", async () => {
    // A Uint8Array view over a larger buffer would otherwise put the whole buffer on the wire.
    const written: number[][] = [];
    const fake = fakeClient([scanResult()], {
      async write(_d, _s, _c, value: DataView) {
        written.push([...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]);
      },
    });
    const { peripheral } = await transport(fake).requestDevice(FILTER);

    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9, 9]);
    await peripheral.write(GEN4.service, GEN4.commandCharacteristic, backing.subarray(2, 5));

    expect(written).toEqual([[1, 2, 3]]);
  });

  it("reports the services the device exposes", async () => {
    const fake = fakeClient([scanResult()]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);
    expect(await peripheral.services()).toEqual([GEN4.service]);
  });

  it("surfaces a dropped link once", async () => {
    const fake = fakeClient([scanResult()]);
    const { peripheral } = await transport(fake).requestDevice(FILTER);

    let drops = 0;
    peripheral.onDisconnect(() => drops++);
    fake.drop();
    fake.drop();

    expect(drops).toBe(1);
  });
});

describe("availability", () => {
  it("is unavailable when the radio is off rather than throwing", async () => {
    const fake = fakeClient([], { async isEnabled() { return false; } });
    expect(await transport(fake).isAvailable()).toBe(false);
  });

  it("is unavailable when the plugin will not initialize", async () => {
    // What a web build would see if this file were ever loaded there.
    const fake = fakeClient([], {
      async initialize() {
        throw new Error("no native bridge");
      },
    });
    expect(await transport(fake).isAvailable()).toBe(false);
  });

  it("refuses to scan with the radio off", async () => {
    const fake = fakeClient([scanResult()], { async isEnabled() { return false; } });
    await expect(transport(fake).requestDevice(FILTER)).rejects.toThrow(/turned off/);
  });

  it("initializes once, however often it is asked", async () => {
    const fake = fakeClient([scanResult()]);
    const radio = transport(fake);
    await radio.isAvailable();
    await radio.requestDevice(FILTER);
    expect(fake.calls.initialize).toBe(1);
  });
});
