/**
 * Recovering a GAN cube's MAC address, which is also its encryption key's salt.
 *
 * This is the single most platform-dependent thing in the whole cube link, and the reason the
 * transport seam has the shape it does.
 *
 * A GAN cube encrypts everything it says with AES-128, keyed from a fixed constant salted with
 * **its own MAC address**. Without the MAC you get bytes you cannot read. And the MAC is not
 * readable from the connection: it appears only in the last six bytes of the manufacturer-specific
 * data in an *advertisement*, reversed.
 *
 * Which means:
 *
 * - **Web Bluetooth** hides device addresses on principle. `watchAdvertisements()` exists but is
 *   unavailable in Safari, flagged off in places, and times out; the fallback has been asking the
 *   user to type their cube's MAC in, which is as bad as it sounds.
 * - **Android** native hands over the real MAC as the device id, so this is nearly free.
 * - **iOS** hides the MAC as thoroughly as Web Bluetooth does — `CBPeripheral.identifier` is a
 *   per-app UUID — but Core Bluetooth *does* hand over manufacturer data during a scan. So the
 *   MAC is recoverable on iOS, from exactly one place, at exactly one moment.
 *
 * That moment is the catch. A reconnect by device id produces no advertisement, so a cube you
 * have already paired with is unreadable unless the MAC was kept. Hence `GanMacStore`.
 */
import { BleTransportError, type BleAdvertisement, type GanMacStore } from "./transport.ts";
import { GAN_COMPANY_IDS } from "./gan-uuids.ts";

/** Manufacturer payloads are longer than this; the MAC is the last six bytes of one. */
const MAC_BYTES = 6;

/** `AB:CD:EF:01:23:45` — uppercase, colon-separated, which is the form the salt is derived from. */
export function formatMac(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(":");
}

/** Accepts colons, dashes or spaces, because people paste all three. */
export function parseMac(text: string): Uint8Array | null {
  const parts = text.trim().split(/[:\-\s]+/);
  if (parts.length !== MAC_BYTES) return null;
  const bytes = new Uint8Array(MAC_BYTES);
  for (const [i, part] of parts.entries()) {
    if (!/^[0-9a-f]{2}$/i.test(part)) return null;
    bytes[i] = Number.parseInt(part, 16);
  }
  return bytes;
}

/** Is this a MAC we could actually use? */
export function isValidMac(text: string): boolean {
  return parseMac(text) !== null;
}

/**
 * Pull the MAC out of an advertisement, or null if it is not in there.
 *
 * The payload's last six bytes are the address in reverse order — least significant first, as it
 * goes over the air. Everything before them is the cube's own business and is not read.
 */
export function macFromAdvertisement(advertisement: BleAdvertisement): string | null {
  for (const companyId of GAN_COMPANY_IDS) {
    const payload = advertisement.manufacturerData.get(companyId);
    if (!payload || payload.byteLength < MAC_BYTES) continue;
    const reversed = payload.slice(payload.byteLength - MAC_BYTES);
    const bytes = new Uint8Array(MAC_BYTES);
    for (let i = 0; i < MAC_BYTES; i++) {
      bytes[i] = reversed[MAC_BYTES - 1 - i]!;
    }
    return formatMac(bytes);
  }
  return null;
}

/**
 * How a MAC was obtained. Worth recording: it says how much to trust it, and a capture that used
 * a typed-in address is a capture whose frames may simply not decrypt.
 */
export type MacSource = "advertisement" | "stored" | "device-id" | "prompt";

export interface ResolvedMac {
  readonly mac: string;
  readonly source: MacSource;
}

export interface ResolveMacOptions {
  readonly deviceId: string;
  /** Null on a reconnect, which is the case this function mostly exists to handle. */
  readonly advertisement: BleAdvertisement | null;
  readonly store?: GanMacStore;
  /**
   * Last resort, when nothing else worked: ask the user. Returning null means give up.
   *
   * On native this should never fire, and if it does it is worth surfacing as a bug rather than
   * as a routine prompt.
   */
  readonly prompt?: () => Promise<string | null>;
}

/**
 * Get a usable MAC, from whichever source has one, and remember it for next time.
 *
 * Order is by reliability, not by speed. A fresh advertisement beats a stored value because the
 * store could be stale — the same device id can be reissued — and both beat asking a person.
 */
export async function resolveMac(options: ResolveMacOptions): Promise<ResolvedMac> {
  const { deviceId, advertisement, store, prompt } = options;

  if (advertisement) {
    const broadcast = macFromAdvertisement(advertisement);
    if (broadcast) {
      await store?.set(deviceId, broadcast);
      return { mac: broadcast, source: "advertisement" };
    }
  }

  const remembered = await store?.get(deviceId);
  if (remembered && isValidMac(remembered)) {
    return { mac: remembered, source: "stored" };
  }

  // Android hands over the real address as the device id. Nothing else does, so this is a
  // recognition rather than an assumption: if it parses as a MAC, it is one.
  if (isValidMac(deviceId)) {
    const normalized = formatMac(parseMac(deviceId)!);
    await store?.set(deviceId, normalized);
    return { mac: normalized, source: "device-id" };
  }

  if (prompt) {
    const typed = await prompt();
    if (typed && isValidMac(typed)) {
      const normalized = formatMac(parseMac(typed)!);
      await store?.set(deviceId, normalized);
      return { mac: normalized, source: "prompt" };
    }
  }

  throw new BleTransportError(
    "Could not determine the cube's MAC address, so its data cannot be decrypted. " +
      "Reconnecting after a fresh scan usually recovers it.",
  );
}
