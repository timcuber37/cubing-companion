"use client";

import {
  WebBluetoothTransport,
  type BleTransport,
  type GanMacStore,
} from "@cubing-companion/cube-link";

/**
 * Which radio this build is running on.
 *
 * One bundle serves the browser and the phone — that is the point of the Capacitor approach — so
 * the choice is made here, once, at runtime. Everything downstream takes a
 * {@link BleTransport} and does not care.
 *
 * The native check reads the global the Capacitor runtime injects into its web view rather than
 * importing `@capacitor/core`. That keeps the web app free of a Capacitor dependency it would
 * never use, and it is the more honest test anyway: what matters is whether a native bridge is
 * actually present, not whether a package was installed.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function isNativeShell(): boolean {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/**
 * The transport for this device, or null when there is no usable radio.
 *
 * Null is the ordinary answer in Safari and on iOS in a browser, and the UI says so rather than
 * offering a button that cannot work.
 */
export async function defaultTransport(): Promise<BleTransport | null> {
  if (isNativeShell()) {
    // Imported dynamically so a plain web build never pulls in the Capacitor plugin.
    const { capacitorTransport } = await import("@cubing-companion/cube-link/capacitor");
    //
    // Returned **without** probing `isAvailable()`, unlike the web branch below, and that is
    // deliberate: on iOS the probe is what triggers the Bluetooth permission dialog. Asking on
    // mount would put a system prompt in front of someone who has just opened the app and may
    // only want to look at their solve history. So the radio is touched when they tap Connect,
    // and a radio that is off surfaces as a clear error then rather than a disabled button now.
    //
    // The cost is that the button is enabled on a device with Bluetooth switched off. That is the
    // right trade — and it is also why `requestDevice` checks `isEnabled()` before scanning.
    return capacitorTransport();
  }

  // In a browser there is no such cost: the check reads a property and prompts nobody.
  const web = new WebBluetoothTransport();
  return (await web.isAvailable()) ? web : null;
}

const MAC_STORAGE_KEY = "cubing-companion.gan-mac";

/**
 * Remembers each cube's MAC address across sessions.
 *
 * Not an optimisation. A GAN cube's decryption key is salted with its MAC, the MAC only ever
 * appears in a scan advertisement, and a reconnect produces no advertisement — so forgetting it
 * means a cube that has already been paired can no longer be read. See `ble/mac.ts`.
 *
 * `localStorage` is the right size of tool for a handful of short strings, but it is browser
 * storage: in a WKWebView it can be evicted under storage pressure. The consequence of losing it
 * is one extra scan, not lost data, so it does not warrant the SQLite treatment that solve history
 * gets in P4.
 */
export function localMacStore(): GanMacStore {
  const read = (): Record<string, string> => {
    try {
      const raw = globalThis.localStorage?.getItem(MAC_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      // Private browsing, blocked site data, or corrupted JSON. An empty store costs a scan.
      return {};
    }
  };

  return {
    async get(deviceId) {
      return read()[deviceId] ?? null;
    },
    async set(deviceId, mac) {
      try {
        globalThis.localStorage?.setItem(
          MAC_STORAGE_KEY,
          JSON.stringify({ ...read(), [deviceId]: mac }),
        );
      } catch {
        // Storage unavailable. The cube still works this session; it just has to be rescanned.
      }
    },
  };
}
