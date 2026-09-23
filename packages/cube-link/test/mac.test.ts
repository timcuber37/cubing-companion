/**
 * MAC recovery, which decides whether a cube's data can be decrypted at all.
 *
 * Worth testing hard for its size, because every failure here looks the same from the outside —
 * a cube that connects and then emits nonsense — and because the platform differences it papers
 * over are exactly what the mobile port is about.
 */
import { describe, expect, it } from "vitest";
import {
  formatMac,
  isValidMac,
  macFromAdvertisement,
  parseMac,
  resolveMac,
} from "../src/ble/mac.ts";
import { MemoryMacStore, type BleAdvertisement } from "../src/ble/transport.ts";
import { fakeAdvertisement } from "../src/ble/fake.ts";

const MAC = "AB:CD:EF:01:23:45";

function advertisement(
  manufacturerData: ReadonlyMap<number, Uint8Array>,
  deviceId = "device-1",
): BleAdvertisement {
  return { deviceId, name: "GAN-1234", manufacturerData, serviceUuids: [], rssi: null };
}

describe("MAC formatting", () => {
  it("round-trips", () => {
    expect(formatMac(parseMac(MAC)!)).toBe(MAC);
  });

  it("accepts colons, dashes and spaces, because people paste all three", () => {
    for (const text of ["AB:CD:EF:01:23:45", "AB-CD-EF-01-23-45", "AB CD EF 01 23 45"]) {
      expect(formatMac(parseMac(text)!)).toBe(MAC);
    }
  });

  it("normalises case", () => {
    expect(formatMac(parseMac("ab:cd:ef:01:23:45")!)).toBe(MAC);
  });

  it("rejects what is not a MAC", () => {
    for (const text of ["", "AB:CD:EF:01:23", "AB:CD:EF:01:23:45:67", "ZZ:CD:EF:01:23:45", "not a mac"]) {
      expect(isValidMac(text), text).toBe(false);
    }
  });
});

describe("reading the MAC from an advertisement", () => {
  it("takes the last six bytes, reversed — the order they go over the air", () => {
    // Payload ends with the address least-significant byte first.
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0x45, 0x23, 0x01, 0xef, 0xcd, 0xab]);
    expect(macFromAdvertisement(advertisement(new Map([[0x0001, payload]])))).toBe(MAC);
  });

  it("finds it under any of GAN's 256 company codes", () => {
    // Which code a given cube uses is not predictable, which is why the scan asks for all of them.
    for (const companyId of [0x0001, 0x0101, 0x5501, 0xff01]) {
      const built = fakeAdvertisement(MAC, { companyId });
      expect(macFromAdvertisement(built), `company ${companyId.toString(16)}`).toBe(MAC);
    }
  });

  it("returns null when there is no manufacturer data", () => {
    expect(macFromAdvertisement(advertisement(new Map()))).toBeNull();
  });

  it("returns null when the payload is too short to hold an address", () => {
    const short = new Uint8Array([0x01, 0x02, 0x03]);
    expect(macFromAdvertisement(advertisement(new Map([[0x0001, short]])))).toBeNull();
  });
});

describe("resolveMac", () => {
  it("prefers a fresh advertisement, and remembers it", async () => {
    const store = new MemoryMacStore();
    const resolved = await resolveMac({
      deviceId: "device-1",
      advertisement: fakeAdvertisement(MAC),
      store,
    });
    expect(resolved).toEqual({ mac: MAC, source: "advertisement" });
    expect(await store.get("device-1")).toBe(MAC);
  });

  it("falls back to what it remembered when a reconnect brings no advertisement", async () => {
    // The case the whole store exists for: iOS reconnects by identifier and never re-advertises,
    // so without this the cube is permanently unreadable after the first session.
    const store = new MemoryMacStore();
    await store.set("device-1", MAC);
    const resolved = await resolveMac({ deviceId: "device-1", advertisement: null, store });
    expect(resolved).toEqual({ mac: MAC, source: "stored" });
  });

  it("trusts a fresh advertisement over a stale stored value", async () => {
    const store = new MemoryMacStore();
    await store.set("device-1", "11:22:33:44:55:66");
    const resolved = await resolveMac({
      deviceId: "device-1",
      advertisement: fakeAdvertisement(MAC),
      store,
    });
    expect(resolved.mac).toBe(MAC);
    expect(await store.get("device-1")).toBe(MAC);
  });

  it("recognises an Android device id, which is the address itself", async () => {
    const store = new MemoryMacStore();
    const resolved = await resolveMac({ deviceId: MAC, advertisement: null, store });
    expect(resolved).toEqual({ mac: MAC, source: "device-id" });
  });

  it("asks only as a last resort, and remembers the answer", async () => {
    const store = new MemoryMacStore();
    let asked = 0;
    const resolved = await resolveMac({
      deviceId: "device-1",
      advertisement: null,
      store,
      prompt: async () => {
        asked++;
        return "ab-cd-ef-01-23-45";
      },
    });
    expect(asked).toBe(1);
    expect(resolved).toEqual({ mac: MAC, source: "prompt" });
    expect(await store.get("device-1")).toBe(MAC);
  });

  it("does not ask when an advertisement already answered", async () => {
    let asked = 0;
    await resolveMac({
      deviceId: "device-1",
      advertisement: fakeAdvertisement(MAC),
      prompt: async () => {
        asked++;
        return MAC;
      },
    });
    expect(asked).toBe(0);
  });

  it("fails clearly when nothing knows the address", async () => {
    await expect(resolveMac({ deviceId: "device-1", advertisement: null })).rejects.toThrow(
      /MAC address/,
    );
  });

  it("fails rather than accepting a typed answer that is not a MAC", async () => {
    await expect(
      resolveMac({ deviceId: "device-1", advertisement: null, prompt: async () => "nope" }),
    ).rejects.toThrow(/MAC address/);
  });

  it("ignores a stored value that is not a MAC", async () => {
    const store = new MemoryMacStore();
    await store.set("device-1", "corrupted");
    await expect(
      resolveMac({ deviceId: "device-1", advertisement: null, store }),
    ).rejects.toThrow(/MAC address/);
  });
});
