/**
 * A {@link BleTransport} backed by a recorded frame log instead of a radio.
 *
 * This is the file that makes the rest of the BLE work testable, and it is the reason the seam was
 * worth introducing before any of it was needed on a phone. A capture taken from a real cube
 * replays here byte for byte, so the protocol driver can be developed, diffed against the
 * reference implementation, and regression-tested in CI, on a machine with no Bluetooth at all.
 *
 * It is deliberately literal: it emits the frames it was given, in order, with the gaps they were
 * recorded with, and it records what was written to it. It does not simulate a cube — a fake that
 * invents plausible responses would pass tests that the real device fails, which is the failure
 * mode this whole approach exists to avoid.
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

/** One recorded notification. */
export interface FakeFrame {
  /** Milliseconds from the start of the recording. */
  readonly atMs: number;
  readonly service: string;
  readonly characteristic: string;
  readonly data: Uint8Array;
}

/** Something the code under test sent to the cube. */
export interface FakeWrite {
  readonly atMs: number;
  readonly service: string;
  readonly characteristic: string;
  readonly data: Uint8Array;
}

export interface FakeDeviceOptions {
  readonly deviceId?: string;
  readonly name?: string | null;
  readonly services?: readonly string[];
  readonly frames?: readonly FakeFrame[];
  /** Null reproduces a reconnect, where no advertisement is seen and the MAC must come from store. */
  readonly advertisement?: BleAdvertisement | null;
  /**
   * Drives frame delivery. Defaults to delivering everything synchronously on subscribe, which is
   * what a decoder test wants; pass a clock to exercise timing.
   */
  readonly clock?: FakeClock;
}

/**
 * Controls when frames arrive.
 *
 * `manual` hands the test the trigger, which is how timing-sensitive behaviour gets tested without
 * real delays or fake timers leaking between cases.
 */
export interface FakeClock {
  readonly mode: "immediate" | "manual";
}

export class FakePeripheral implements BlePeripheral {
  readonly deviceId: string;
  readonly name: string | null;
  private readonly exposed: readonly string[];
  private readonly frames: readonly FakeFrame[];
  private readonly mode: FakeClock["mode"];
  private readonly disconnectListeners = new Listeners<void>();
  private readonly subscriptions = new Map<
    string,
    (data: Uint8Array, receivedAt: number) => void
  >();
  private delivered = 0;
  private connected = true;

  /** Everything written to the cube, in order. The point of the fake, for command tests. */
  readonly writes: FakeWrite[] = [];

  constructor(options: FakeDeviceOptions = {}) {
    this.deviceId = options.deviceId ?? "fake-device";
    this.name = options.name === undefined ? "GAN-FAKE" : options.name;
    this.exposed = (options.services ?? []).map((uuid) => uuid.toLowerCase());
    this.frames = options.frames ?? [];
    this.mode = options.clock?.mode ?? "immediate";
  }

  async services(): Promise<readonly string[]> {
    this.assertConnected();
    return this.exposed;
  }

  async write(service: string, characteristic: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    this.writes.push({
      atMs: this.delivered === 0 ? 0 : (this.frames[this.delivered - 1]?.atMs ?? 0),
      service: service.toLowerCase(),
      characteristic: characteristic.toLowerCase(),
      // Copied, so a caller reusing its buffer cannot rewrite history.
      data: data.slice(),
    });
  }

  async subscribe(
    service: string,
    characteristic: string,
    onValue: (data: Uint8Array, receivedAt: number) => void,
  ): Promise<Unsubscribe> {
    this.assertConnected();
    const key = `${service.toLowerCase()}/${characteristic.toLowerCase()}`;
    this.subscriptions.set(key, onValue);
    if (this.mode === "immediate") this.flush();
    return () => {
      this.subscriptions.delete(key);
    };
  }

  /** Deliver the next `count` recorded frames. Only useful with a manual clock. */
  deliver(count = 1): number {
    let sent = 0;
    while (sent < count && this.delivered < this.frames.length) {
      if (this.emit(this.frames[this.delivered]!)) sent++;
      this.delivered++;
    }
    return sent;
  }

  /** Deliver everything that is left. */
  flush(): number {
    return this.deliver(this.frames.length - this.delivered);
  }

  private emit(frame: FakeFrame): boolean {
    const listener = this.subscriptions.get(
      `${frame.service.toLowerCase()}/${frame.characteristic.toLowerCase()}`,
    );
    if (!listener) return false;
    listener(frame.data.slice(), frame.atMs);
    return true;
  }

  onDisconnect(listener: () => void): Unsubscribe {
    return this.disconnectListeners.add(listener);
  }

  /** Simulate the cube going away, as opposed to us hanging up. */
  dropConnection(): void {
    if (!this.connected) return;
    this.connected = false;
    this.subscriptions.clear();
    this.disconnectListeners.emit();
  }

  async disconnect(): Promise<void> {
    this.dropConnection();
  }

  private assertConnected(): void {
    if (!this.connected) throw new BleTransportError("the fake peripheral is disconnected");
  }
}

export interface FakeTransportOptions extends FakeDeviceOptions {
  /** Reproduces a platform where BLE is simply not there. */
  readonly available?: boolean;
}

export class FakeTransport implements BleTransport {
  readonly kind = "fake" as const;
  private readonly options: FakeTransportOptions;

  /** The filter the last `requestDevice` was called with, so tests can assert on discovery. */
  lastFilter: BleScanFilter | null = null;
  /** Every peripheral handed out, so a test can drive one after the code under test has it. */
  readonly peripherals: FakePeripheral[] = [];

  constructor(options: FakeTransportOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return this.options.available ?? true;
  }

  async requestDevice(filter: BleScanFilter): Promise<BleConnection> {
    this.lastFilter = filter;
    if (!(await this.isAvailable())) {
      throw new BleTransportError("this fake transport is configured as unavailable");
    }
    const peripheral = new FakePeripheral(this.options);
    this.peripherals.push(peripheral);
    return {
      peripheral,
      advertisement:
        this.options.advertisement === undefined
          ? advertisementFor(peripheral.deviceId, peripheral.name)
          : this.options.advertisement,
    };
  }
}

/** A plausible GAN advertisement carrying `mac`, for tests that need one. */
export function fakeAdvertisement(
  mac: string,
  options: { deviceId?: string; name?: string | null; companyId?: number } = {},
): BleAdvertisement {
  const bytes = mac.split(/[:\-\s]+/).map((part) => Number.parseInt(part, 16));
  if (bytes.length !== 6 || bytes.some((byte) => !Number.isInteger(byte))) {
    throw new BleTransportError(`not a MAC address: ${mac}`);
  }
  // Three leading bytes of whatever, then the address least-significant-first, as on the air.
  const payload = new Uint8Array([0x00, 0x00, 0x00, ...bytes.reverse()]);
  return {
    deviceId: options.deviceId ?? "fake-device",
    name: options.name === undefined ? "GAN-FAKE" : options.name,
    manufacturerData: new Map([[options.companyId ?? 0x0001, payload]]),
    serviceUuids: [],
    rssi: -50,
  };
}

function advertisementFor(deviceId: string, name: string | null): BleAdvertisement {
  return fakeAdvertisement("AB:CD:EF:01:23:45", { deviceId, name });
}
