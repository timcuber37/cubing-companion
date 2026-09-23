/**
 * {@link BleTransport} over Web Bluetooth.
 *
 * **The only file in this package allowed to touch `navigator`**, which
 * `test/boundaries.test.ts` enforces. Everything else — protocol, tracking, timing, diagnostics —
 * talks to the interface and does not know which radio it got.
 *
 * Web Bluetooth's shape is close enough to the interface that most of this is renaming. The one
 * place it fights is advertisements: `watchAdvertisements()` is the only way to see manufacturer
 * data, it is not implemented everywhere, and it resolves whenever the device next happens to
 * broadcast — so it is raced against a timeout and allowed to come back empty. `mac.ts` handles
 * the empty case; see there for why that matters so much.
 *
 * The DOM types are declared structurally rather than pulled from `@types/web-bluetooth`. They
 * describe a handful of methods, the package typechecks under `"lib": ["ES2022"]` with no DOM
 * types at all, and a dependency whose only job is to describe eight calls is not worth the
 * resolution it costs in a workspace that also builds for Node.
 */
import {
  BleTransportError,
  type BleAdvertisement,
  type BleConnection,
  type BlePeripheral,
  type BleScanFilter,
  type BleTransport,
} from "./transport.ts";
import type { Unsubscribe } from "../source.ts";

/** How long to wait for the device to broadcast before giving up on reading its MAC. */
const ADVERTISEMENT_TIMEOUT_MS = 10_000;

interface WebBluetoothCharacteristic {
  readonly uuid: string;
  readonly value?: { buffer: ArrayBufferLike; byteLength: number } | null;
  writeValue(value: Uint8Array): Promise<void>;
  startNotifications(): Promise<WebBluetoothCharacteristic>;
  stopNotifications(): Promise<WebBluetoothCharacteristic>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface WebBluetoothService {
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<WebBluetoothCharacteristic>;
}

interface WebBluetoothServer {
  connect(): Promise<WebBluetoothServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<WebBluetoothService[]>;
  readonly connected: boolean;
}

interface WebBluetoothDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: WebBluetoothServer;
  watchAdvertisements?(options?: { signal?: AbortSignal }): Promise<void>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface WebBluetoothApi {
  requestDevice(options: {
    filters: { namePrefix: string }[];
    optionalServices: string[];
    optionalManufacturerData: number[];
  }): Promise<WebBluetoothDevice>;
}

function api(): WebBluetoothApi | null {
  const candidate = (globalThis as { navigator?: { bluetooth?: WebBluetoothApi } }).navigator
    ?.bluetooth;
  return candidate ?? null;
}

/** The same answer Safari gives, and the same one Node gives. */
export function isWebBluetoothAvailable(): boolean {
  return api() !== null;
}

/**
 * Read one advertisement's manufacturer data, if the browser will show us one.
 *
 * Resolves null rather than rejecting on every failure path — no support, no broadcast in time,
 * an abort. None of those are errors here: they mean "fall back to the stored MAC", which is a
 * normal reconnect, not a problem.
 */
async function firstAdvertisement(
  device: WebBluetoothDevice,
  timeoutMs: number,
): Promise<ReadonlyMap<number, Uint8Array> | null> {
  if (typeof device.watchAdvertisements !== "function") return null;

  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;

    const finish = (value: ReadonlyMap<number, Uint8Array> | null) => {
      if (settled) return;
      settled = true;
      device.removeEventListener("advertisementreceived", onAdvertisement);
      clearTimeout(timer);
      controller.abort();
      resolve(value);
    };

    const onAdvertisement = (event: Event) => {
      const data = (event as { manufacturerData?: Map<number, { buffer: ArrayBufferLike; byteLength: number; byteOffset: number }> })
        .manufacturerData;
      if (!data) {
        finish(null);
        return;
      }
      const copied = new Map<number, Uint8Array>();
      for (const [companyId, view] of data) {
        copied.set(companyId, new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
      }
      finish(copied);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    device.addEventListener("advertisementreceived", onAdvertisement);
    device.watchAdvertisements!({ signal: controller.signal }).catch(() => finish(null));
  });
}

class WebBluetoothPeripheral implements BlePeripheral {
  private readonly characteristics = new Map<string, WebBluetoothCharacteristic>();
  private cachedServices: WebBluetoothService[] | null = null;

  constructor(
    private readonly device: WebBluetoothDevice,
    private readonly server: WebBluetoothServer,
  ) {}

  get deviceId(): string {
    return this.device.id;
  }

  get name(): string | null {
    return this.device.name ?? null;
  }

  private async primaryServices(): Promise<WebBluetoothService[]> {
    this.cachedServices ??= await this.server.getPrimaryServices();
    return this.cachedServices;
  }

  async services(): Promise<readonly string[]> {
    return (await this.primaryServices()).map((service) => service.uuid.toLowerCase());
  }

  /** Characteristics are cached because rediscovering one per write is a round trip per command. */
  private async characteristic(
    service: string,
    characteristic: string,
  ): Promise<WebBluetoothCharacteristic> {
    const key = `${service}/${characteristic}`;
    const cached = this.characteristics.get(key);
    if (cached) return cached;

    const found = (await this.primaryServices()).find(
      (candidate) => candidate.uuid.toLowerCase() === service.toLowerCase(),
    );
    if (!found) throw new BleTransportError(`the cube does not expose service ${service}`);

    try {
      const resolved = await found.getCharacteristic(characteristic);
      this.characteristics.set(key, resolved);
      return resolved;
    } catch (cause) {
      throw new BleTransportError(`characteristic ${characteristic} is unavailable`, cause);
    }
  }

  async write(service: string, characteristic: string, data: Uint8Array): Promise<void> {
    const target = await this.characteristic(service, characteristic);
    // `writeValue` wants a fresh view; a Uint8Array over a larger buffer would send the lot.
    await target.writeValue(data.slice());
  }

  async subscribe(
    service: string,
    characteristic: string,
    onValue: (data: Uint8Array, receivedAt: number) => void,
  ): Promise<Unsubscribe> {
    const target = await this.characteristic(service, characteristic);

    const listener = (event: Event) => {
      // Stamped first: everything after this is our own latency, not the radio's.
      const receivedAt = performance.now();
      const value = (event.target as WebBluetoothCharacteristic | null)?.value;
      if (!value || value.byteLength === 0) return;
      onValue(new Uint8Array(value.buffer.slice(0, value.byteLength)), receivedAt);
    };

    target.addEventListener("characteristicvaluechanged", listener);
    await target.startNotifications();

    return () => {
      target.removeEventListener("characteristicvaluechanged", listener);
      // Best effort: the device is often already gone by the time we unsubscribe.
      void target.stopNotifications().catch(() => {});
    };
  }

  onDisconnect(listener: () => void): Unsubscribe {
    const wrapped = () => listener();
    this.device.addEventListener("gattserverdisconnected", wrapped);
    return () => this.device.removeEventListener("gattserverdisconnected", wrapped);
  }

  async disconnect(): Promise<void> {
    if (this.server.connected) this.server.disconnect();
  }
}

export interface WebBluetoothTransportOptions {
  /** Shortened in tests; the default is generous because a cube broadcasts on its own schedule. */
  readonly advertisementTimeoutMs?: number;
}

export class WebBluetoothTransport implements BleTransport {
  readonly kind = "web-bluetooth" as const;
  private readonly advertisementTimeoutMs: number;

  constructor(options: WebBluetoothTransportOptions = {}) {
    this.advertisementTimeoutMs = options.advertisementTimeoutMs ?? ADVERTISEMENT_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    return isWebBluetoothAvailable();
  }

  async requestDevice(filter: BleScanFilter): Promise<BleConnection> {
    const bluetooth = api();
    if (!bluetooth) {
      throw new BleTransportError(
        "Web Bluetooth is unavailable. Smart cubes need Chrome or Edge on desktop, or Chrome on " +
          "Android; Safari and iOS do not support it.",
      );
    }

    const device = await bluetooth.requestDevice({
      filters: filter.namePrefixes.map((namePrefix) => ({ namePrefix })),
      optionalServices: [...filter.optionalServices],
      optionalManufacturerData: [...filter.manufacturerCompanyIds],
    });

    // Before connecting: on some platforms advertisements stop once a connection is up.
    const manufacturerData = await firstAdvertisement(device, this.advertisementTimeoutMs);

    if (!device.gatt) throw new BleTransportError("the chosen device exposes no GATT server");
    const server = await device.gatt.connect();

    return {
      peripheral: new WebBluetoothPeripheral(device, server),
      advertisement:
        manufacturerData === null
          ? null
          : ({
              deviceId: device.id,
              name: device.name ?? null,
              manufacturerData,
              serviceUuids: [],
              rssi: null,
            } satisfies BleAdvertisement),
    };
  }
}
