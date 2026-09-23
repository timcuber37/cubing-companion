/**
 * {@link BleTransport} over native Bluetooth, through Capacitor.
 *
 * The other half of the seam `web.ts` fills in a browser — and the reason the seam exists, because
 * this is what runs on an iPhone, where Web Bluetooth does not and will not.
 *
 * **This scans rather than using the plugin's `requestDevice`.** That matters more than it looks:
 * a GAN cube's decryption key is salted with its MAC, and the MAC appears *only* in advertisement
 * manufacturer data. `requestDevice` presents a native picker and returns a device with no
 * advertisement attached, so a cube connected that way cannot be decrypted at all unless its
 * address was already known. `requestLEScan` hands over every advertisement it sees, which is
 * where the address is. See `mac.ts` for the whole picture.
 *
 * The cost of scanning instead of picking is that there is no system chooser, so this has to
 * decide which cube to connect to. `chooseDevice` is the hook for asking a person; the default
 * takes the strongest signal, which is the right answer when exactly one cube is on the desk and
 * a defensible one when two are.
 *
 * Nothing else in the package imports `@capacitor/*` — `test/boundaries.test.ts` enforces that —
 * so a web build never loads this file, and this package still installs without Capacitor present.
 */
import { Listeners, type Unsubscribe } from "../source.ts";
import {
  BleTransportError,
  type BleAdvertisement,
  type BleConnection,
  type BlePeripheral,
  type BleScanFilter,
  type BleTransport,
} from "./transport.ts";

/** How long to gather advertisements before deciding which cube to connect to. */
const DEFAULT_SCAN_MS = 4_000;
/** Stop early once a cube has been seen and the air has gone quiet. */
const SETTLE_MS = 800;

/** One cube seen during a scan. */
export interface DiscoveredDevice {
  readonly deviceId: string;
  readonly name: string | null;
  readonly rssi: number | null;
  /** True when this advertisement carried manufacturer data, and so an address. */
  readonly hasManufacturerData: boolean;
}

export interface CapacitorBleTransportOptions {
  /**
   * Pick which cube to connect to. Resolving to null aborts.
   *
   * Without one, the strongest signal wins — and a cube in your hand is reliably stronger than a
   * cube in the next room.
   */
  readonly chooseDevice?: (
    devices: readonly DiscoveredDevice[],
  ) => Promise<DiscoveredDevice | null>;
  readonly scanMs?: number;
}

/** The slice of `@capacitor-community/bluetooth-le` this uses, declared so tests can fake it. */
export interface BleClientLike {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  isEnabled(): Promise<boolean>;
  requestLEScan(
    options: { services?: string[]; allowDuplicates?: boolean; scanMode?: number },
    callback: (result: ScanResultLike) => void,
  ): Promise<void>;
  stopLEScan(): Promise<void>;
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  getServices(deviceId: string): Promise<{ uuid: string }[]>;
  write(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>;
}

export interface ScanResultLike {
  device: { deviceId: string; name?: string };
  localName?: string;
  rssi?: number;
  /** Company identifier as a decimal string, to a payload. */
  manufacturerData?: Record<string, DataView>;
  uuids?: string[];
}

const bytesOf = (view: DataView): Uint8Array =>
  new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));

function advertisementFrom(result: ScanResultLike): BleAdvertisement {
  const manufacturerData = new Map<number, Uint8Array>();
  for (const [companyId, payload] of Object.entries(result.manufacturerData ?? {})) {
    const id = Number.parseInt(companyId, 10);
    if (Number.isInteger(id)) manufacturerData.set(id, bytesOf(payload));
  }
  return {
    deviceId: result.device.deviceId,
    name: result.localName ?? result.device.name ?? null,
    manufacturerData,
    serviceUuids: (result.uuids ?? []).map((uuid) => uuid.toLowerCase()),
    rssi: result.rssi ?? null,
  };
}

class CapacitorPeripheral implements BlePeripheral {
  private readonly disconnectListeners = new Listeners<void>();
  private services_: string[] | null = null;
  private connected = true;

  constructor(
    private readonly client: BleClientLike,
    readonly deviceId: string,
    readonly name: string | null,
  ) {}

  /** @internal called by the transport when the platform reports the link dropped. */
  dropped(): void {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectListeners.emit();
  }

  async services(): Promise<readonly string[]> {
    this.services_ ??= (await this.client.getServices(this.deviceId)).map((service) =>
      service.uuid.toLowerCase(),
    );
    return this.services_;
  }

  async write(service: string, characteristic: string, data: Uint8Array): Promise<void> {
    // A fresh copy: the plugin serialises across the bridge, and a view over a larger buffer
    // would send the whole thing.
    const copy = data.slice();
    await this.client.write(
      this.deviceId,
      service,
      characteristic,
      new DataView(copy.buffer, copy.byteOffset, copy.byteLength),
    );
  }

  async subscribe(
    service: string,
    characteristic: string,
    onValue: (data: Uint8Array, receivedAt: number) => void,
  ): Promise<Unsubscribe> {
    await this.client.startNotifications(this.deviceId, service, characteristic, (value) => {
      // Stamped here, which is as close to the radio as a bridged plugin allows. It includes
      // native-to-JS hop latency, which is exactly why `timeline.ts` trusts the cube's clock
      // rather than this one.
      onValue(bytesOf(value), performance.now());
    });
    return () => {
      void this.client.stopNotifications(this.deviceId, service, characteristic).catch(() => {});
    };
  }

  onDisconnect(listener: () => void): Unsubscribe {
    return this.disconnectListeners.add(listener);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.disconnect(this.deviceId).catch(() => {});
  }
}

export class CapacitorBleTransport implements BleTransport {
  readonly kind = "capacitor" as const;
  private initialized = false;

  constructor(
    private readonly client: BleClientLike,
    private readonly options: CapacitorBleTransportOptions = {},
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.initialize();
      return await this.client.isEnabled();
    } catch {
      return false;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    // `androidNeverForLocation` is left off deliberately. It would let Android skip the location
    // permission, but the platform then filters location-derivable scan results — and the
    // manufacturer data the MAC lives in may be among them. Revisit only with a device to test on.
    await this.client.initialize();
    this.initialized = true;
  }

  async requestDevice(filter: BleScanFilter): Promise<BleConnection> {
    await this.initialize();
    if (!(await this.client.isEnabled())) {
      throw new BleTransportError("Bluetooth is turned off.");
    }

    const seen = await this.scan(filter);
    if (seen.size === 0) {
      throw new BleTransportError(
        "No smart cube was found. Check the cube is awake — turn a face — and close by.",
      );
    }

    const chosen = await this.choose([...seen.values()]);
    if (!chosen) throw new BleTransportError("No cube was chosen.");
    const advertisement = seen.get(chosen.deviceId)!;

    const peripheral = new CapacitorPeripheral(
      this.client,
      advertisement.deviceId,
      advertisement.name,
    );
    await this.client.connect(advertisement.deviceId, () => peripheral.dropped());

    return {
      peripheral,
      // Carries the manufacturer data, and therefore the cube's address. Without this the key
      // cannot be derived and nothing the cube says can be read.
      advertisement,
    };
  }

  /** Gather advertisements, keeping the strongest sighting of each device. */
  private async scan(filter: BleScanFilter): Promise<Map<string, BleAdvertisement>> {
    const seen = new Map<string, BleAdvertisement>();
    const scanMs = this.options.scanMs ?? DEFAULT_SCAN_MS;

    await this.client.requestLEScan({ allowDuplicates: true }, (result) => {
      const advertisement = advertisementFrom(result);
      if (!matches(advertisement, filter)) return;
      const existing = seen.get(advertisement.deviceId);
      // Later advertisements may carry manufacturer data the first one lacked, so prefer one that
      // has it over one that merely has a stronger signal.
      if (
        !existing ||
        (advertisement.manufacturerData.size > 0 && existing.manufacturerData.size === 0) ||
        (advertisement.rssi ?? -999) > (existing.rssi ?? -999)
      ) {
        seen.set(advertisement.deviceId, advertisement);
      }
    });

    try {
      await settle(scanMs, SETTLE_MS, () => seen.size > 0);
    } finally {
      await this.client.stopLEScan().catch(() => {});
    }
    return seen;
  }

  private async choose(
    advertisements: readonly BleAdvertisement[],
  ): Promise<DiscoveredDevice | null> {
    const devices: DiscoveredDevice[] = advertisements.map((advertisement) => ({
      deviceId: advertisement.deviceId,
      name: advertisement.name,
      rssi: advertisement.rssi,
      hasManufacturerData: advertisement.manufacturerData.size > 0,
    }));

    if (this.options.chooseDevice) return this.options.chooseDevice(devices);
    return [...devices].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))[0] ?? null;
  }
}

/** Client-side name filtering, because the plugin takes only one name prefix. */
function matches(advertisement: BleAdvertisement, filter: BleScanFilter): boolean {
  if (filter.namePrefixes.length === 0) return true;
  const name = advertisement.name;
  if (name && filter.namePrefixes.some((prefix) => name.startsWith(prefix))) return true;
  // A cube that withholds its name in the advertisement can still be recognised by its service.
  const services = new Set(advertisement.serviceUuids);
  return filter.optionalServices.some((uuid) => services.has(uuid.toLowerCase()));
}

/** Wait up to `limitMs`, finishing `quietMs` after the condition first holds. */
async function settle(limitMs: number, quietMs: number, found: () => boolean): Promise<void> {
  const started = Date.now();
  let firstFoundAt: number | null = null;
  for (;;) {
    const now = Date.now();
    if (found() && firstFoundAt === null) firstFoundAt = now;
    if (now - started >= limitMs) return;
    if (firstFoundAt !== null && now - firstFoundAt >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The transport for this device, wired to the real plugin.
 *
 * Imports `@capacitor-community/bluetooth-le` dynamically so that merely importing this module
 * does not require Capacitor to be installed.
 */
export async function capacitorTransport(
  options: CapacitorBleTransportOptions = {},
): Promise<CapacitorBleTransport> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");
  return new CapacitorBleTransport(BleClient as unknown as BleClientLike, options);
}
