/**
 * The BLE transport seam.
 *
 * Everything above this file is protocol: which bytes mean a turn, how they are encrypted, what
 * the cube's clock is doing. Everything below it is a radio, and radios differ. Web Bluetooth,
 * Core Bluetooth behind a Capacitor bridge, and a recorded frame log are three implementations of
 * the same eight operations.
 *
 * This exists because `gan-web-bluetooth` offers no such seam — `connectGanCube` takes a MAC
 * provider and calls `navigator.bluetooth.requestDevice` itself, so there is nowhere to hand it a
 * different radio. That is fine on the web and fatal on iOS, where Web Bluetooth does not exist.
 * `MOBILE_PLAN.md` has the reasoning.
 *
 * Nothing in this file imports a platform. That is the point: it is the one description of a BLE
 * device that both `web.ts` and a future `capacitor.ts` have to satisfy, and that `fake.ts` can
 * satisfy from a file, which is what makes any of this testable without hardware.
 */
import type { Unsubscribe } from "../source.ts";

/**
 * One advertisement packet, as seen during a scan.
 *
 * The GAN MAC lives in `manufacturerData` and nowhere else — see `mac.ts` for why that matters
 * more than it sounds like it should.
 */
export interface BleAdvertisement {
  /**
   * The platform's handle for this device.
   *
   * **Not a MAC address.** Web Bluetooth gives an opaque per-origin id; Core Bluetooth gives a
   * per-app UUID; Android gives the actual MAC. Treat it as a key for reconnecting, never as a
   * device address, and never derive anything from it.
   */
  readonly deviceId: string;
  readonly name: string | null;
  /**
   * Company Identifier Code to payload, exactly as the peripheral broadcast it.
   *
   * GAN uses all 256 codes in `[0x0001, 0xFF01]`, apparently arbitrarily per device, which is why
   * the scan filter asks for all of them rather than one.
   */
  readonly manufacturerData: ReadonlyMap<number, Uint8Array>;
  readonly serviceUuids: readonly string[];
  /** Signal strength in dBm when the platform reports it. Diagnostics only. */
  readonly rssi: number | null;
}

/** What to look for. Shaped after what both Web Bluetooth and native scanners accept. */
export interface BleScanFilter {
  readonly namePrefixes: readonly string[];
  /** Services that must be requestable after connecting, whether or not they are advertised. */
  readonly optionalServices: readonly string[];
  /** Company codes whose manufacturer data the platform should surface to us. */
  readonly manufacturerCompanyIds: readonly number[];
}

/** A connected device. */
export interface BlePeripheral {
  readonly deviceId: string;
  readonly name: string | null;

  /** Services this peripheral actually exposes, lowercased. Decides which protocol it speaks. */
  services(): Promise<readonly string[]>;

  write(service: string, characteristic: string, data: Uint8Array): Promise<void>;

  /**
   * Subscribe to notifications on a characteristic.
   *
   * `receivedAt` is stamped as close to the radio as the platform allows, which under a native
   * bridge includes bridge latency. That is exactly why it is not the per-move truth: the cube's
   * own clock is, and `timeline.ts` fits one onto the other. Recorded here so a capture can show
   * what the host saw and when, not so anything downstream can trust it.
   */
  subscribe(
    service: string,
    characteristic: string,
    onValue: (data: Uint8Array, receivedAt: number) => void,
  ): Promise<Unsubscribe>;

  onDisconnect(listener: () => void): Unsubscribe;
  disconnect(): Promise<void>;
}

/** What a transport hands back once the user has picked a device. */
export interface BleConnection {
  readonly peripheral: BlePeripheral;
  /**
   * The advertisement seen on the way in, when there was a scan.
   *
   * **Null when the platform connected without scanning** — the reconnect-by-id case, and the
   * whole reason {@link GanMacStore} exists. A GAN cube's encryption key is salted with its MAC,
   * the MAC only ever appears in an advertisement, and a reconnect produces no advertisement. So
   * a cube you have already paired with is unreadable unless you remembered its MAC yourself.
   */
  readonly advertisement: BleAdvertisement | null;
}

/** A radio. */
export interface BleTransport {
  readonly kind: "web-bluetooth" | "capacitor" | "fake";

  /** Whether this transport can run here at all. Cheap, and safe to call anywhere. */
  isAvailable(): Promise<boolean>;

  /**
   * Present a device chooser, connect to what the user picks, and report what was advertised.
   *
   * Must be called from a user gesture on platforms that require one — Web Bluetooth will not
   * show its chooser otherwise.
   */
  requestDevice(filter: BleScanFilter): Promise<BleConnection>;
}

/**
 * Remembers which MAC belongs to which device handle.
 *
 * Not a cache in the "we could recompute this" sense: the MAC genuinely cannot be recovered
 * without a fresh advertisement, so losing this means the user has to forget and re-pair the cube.
 * Persist it.
 */
export interface GanMacStore {
  get(deviceId: string): Promise<string | null>;
  set(deviceId: string, mac: string): Promise<void>;
}

/** A {@link GanMacStore} that forgets. The default, and the right one for tests. */
export class MemoryMacStore implements GanMacStore {
  private readonly entries = new Map<string, string>();

  async get(deviceId: string): Promise<string | null> {
    return this.entries.get(deviceId) ?? null;
  }

  async set(deviceId: string, mac: string): Promise<void> {
    this.entries.set(deviceId, mac);
  }
}

/** Raised when a transport cannot do what was asked. Distinct from a protocol-level failure. */
export class BleTransportError extends Error {
  override readonly name = "BleTransportError";

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}
