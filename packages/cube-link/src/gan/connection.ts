/**
 * A GAN cube connection over a {@link BleTransport}.
 *
 * This is the piece that replaces `gan-web-bluetooth`'s `GanCubeClassicConnection`, and the reason
 * any of the vendoring was worth doing: the reference talks to `navigator.bluetooth` directly, so
 * there was nowhere to hand it a different radio. This talks to the transport interface, which
 * Web Bluetooth satisfies today and a native bridge will satisfy on a phone.
 *
 * It implements {@link GanConnectionLike} — the structural interface `gan.ts` already consumed
 * from the library — so `GanCubeSource`, the diagnostics recorder, the app and every existing test
 * are untouched by the swap.
 *
 * Two behaviours here are deliberately better than the reference rather than faithful to it:
 *
 * - **Notifications are handled one at a time.** `handleStateEvent` is async, because a gap makes
 *   it request move history mid-handler. The reference calls it straight from the characteristic
 *   event, so two notifications arriving close together interleave inside the move buffer — which
 *   is a rare, unreproducible reordering of exactly the moves that were already in trouble. Here
 *   they queue.
 * - **A decode failure drops the frame** instead of escaping into whatever called the listener.
 *   Over BLE a mangled packet is a normal event; ending the session over one is not proportionate.
 */
import { Listeners, type Unsubscribe } from "../source.ts";
import {
  GAN_COMPANY_IDS,
  GAN_NAME_PREFIXES,
  GAN_SERVICES,
  profileFor,
  type GanServiceProfile,
} from "../ble/gan-uuids.ts";
import { resolveMac, type MacSource } from "../ble/mac.ts";
import {
  BleTransportError,
  type BleTransport,
  type BlePeripheral,
  type GanMacStore,
} from "../ble/transport.ts";
import { encrypterFor, type GanEncrypter } from "./crypto.ts";
import { REQUEST_REPEAT_MS } from "./buffer.ts";
import { GanGen2Driver } from "./gen2.ts";
import { GanGen3Driver } from "./gen3.ts";
import { GanGen4Driver } from "./gen4.ts";
import type {
  GanCubeCommand,
  GanCubeEvent,
  GanDriverConnection,
  GanProtocolDriver,
} from "./events.ts";

/** Anything shorter than one AES block cannot be a message. */
const MIN_FRAME = 16;

export interface GanConnectionOptions {
  readonly store?: GanMacStore;
  readonly prompt?: () => Promise<string | null>;
  /** Injected in tests; defaults to the host clock the rest of the package uses. */
  readonly now?: () => number;
}

function driverFor(profile: GanServiceProfile, now: () => number): GanProtocolDriver {
  switch (profile.protocol) {
    case "gen2":
      return new GanGen2Driver(now);
    // Eager recovery: see `RecoveryMode` in `buffer.ts` for what it fixes and how it was measured.
    case "gen3":
      return new GanGen3Driver(now, "eager");
    case "gen4":
      return new GanGen4Driver(now, "eager");
  }
}

export class GanConnection implements GanDriverConnection {
  private readonly listeners = new Listeners<GanCubeEvent>();
  /** Serialises notification handling; see the note at the top of this file. */
  private queue: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNotifications: Unsubscribe | null = null;
  private unsubscribeDisconnect: Unsubscribe | null = null;
  private open = true;

  private constructor(
    private readonly peripheral: BlePeripheral,
    private readonly profile: GanServiceProfile,
    private readonly encrypter: GanEncrypter,
    private readonly driver: GanProtocolDriver,
    private readonly now: () => number,
    /** How the MAC was obtained. Diagnostic only; never the address itself. */
    readonly macSource: MacSource,
  ) {}

  static async open(
    transport: BleTransport,
    options: GanConnectionOptions = {},
  ): Promise<GanConnection> {
    const now = options.now ?? (() => performance.now());
    const { peripheral, advertisement } = await transport.requestDevice({
      namePrefixes: GAN_NAME_PREFIXES,
      optionalServices: GAN_SERVICES.map((profile) => profile.service),
      manufacturerCompanyIds: GAN_COMPANY_IDS,
    });

    try {
      const profile = profileFor(await peripheral.services());
      if (!profile) {
        throw new BleTransportError(
          "This device does not expose a known GAN service, so its protocol is unsupported.",
        );
      }

      const { mac, source } = await resolveMac({
        deviceId: peripheral.deviceId,
        advertisement,
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      });

      const connection = new GanConnection(
        peripheral,
        profile,
        encrypterFor(peripheral.name, mac),
        driverFor(profile, now),
        now,
        source,
      );
      await connection.start();
      return connection;
    } catch (error) {
      await peripheral.disconnect().catch(() => {});
      throw error;
    }
  }

  private async start(): Promise<void> {
    this.unsubscribeDisconnect = this.peripheral.onDisconnect(() => this.handleDropped());
    this.unsubscribeNotifications = await this.peripheral.subscribe(
      this.profile.service,
      this.profile.stateCharacteristic,
      (data) => this.enqueue(data),
    );
    // Eager recovery retries lost moves on a timer rather than waiting for a frame to prompt it.
    // Through the same queue as frames, so a retry never interleaves with a frame being decoded.
    if (this.driver.retry) {
      this.retryTimer = setInterval(() => {
        this.queue = this.queue.then(() => this.open ? this.driver.retry?.(this) : undefined).catch(() => {});
      }, REQUEST_REPEAT_MS);
    }
  }

  /** Keeps frames in arrival order even though decoding one can await a write. */
  private enqueue(data: Uint8Array): void {
    this.queue = this.queue.then(() => this.handleFrame(data)).catch(() => {});
  }

  private async handleFrame(data: Uint8Array): Promise<void> {
    if (!this.open || data.byteLength < MIN_FRAME) return;
    let events: GanCubeEvent[];
    try {
      events = await this.driver.handleStateEvent(this, this.encrypter.decrypt(data));
    } catch {
      // A frame we could not make sense of. The cube keeps talking; the tracker will notice any
      // resulting disagreement through the serial gap it already watches for.
      return;
    }
    for (const event of events) this.listeners.emit(event);
  }

  private handleDropped(): void {
    if (!this.open) return;
    this.open = false;
    this.listeners.emit({ type: "DISCONNECT", timestamp: this.now() });
    this.teardown();
  }

  private teardown(): void {
    if (this.retryTimer !== null) clearInterval(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribeNotifications?.();
    this.unsubscribeDisconnect?.();
    this.unsubscribeNotifications = null;
    this.unsubscribeDisconnect = null;
  }

  // ---- GanConnectionLike, as `gan.ts` consumes it -------------------------------------------

  get deviceName(): string {
    return this.peripheral.name ?? "GAN-XXXX";
  }

  /** Best-effort diagnostics: UUIDs only, never the device address or the key. */
  get stateCharacteristic(): { uuid: string; service: { uuid: string } } {
    return {
      uuid: this.profile.stateCharacteristic,
      service: { uuid: this.profile.service },
    };
  }

  readonly events$ = {
    subscribe: (observer: (event: GanCubeEvent) => void): { unsubscribe(): void } => {
      const unsubscribe = this.listeners.add(observer);
      return { unsubscribe };
    },
  };

  /** @internal used by the driver to request move history. */
  async sendCommandMessage(message: Uint8Array): Promise<void> {
    if (!this.open) throw new BleTransportError("the cube is disconnected");
    await this.peripheral.write(
      this.profile.service,
      this.profile.commandCharacteristic,
      this.encrypter.encrypt(message),
    );
  }

  async sendCubeCommand(command: GanCubeCommand): Promise<void> {
    const message = this.driver.createCommandMessage(command);
    if (!message) throw new BleTransportError(`unsupported command: ${command.type}`);
    await this.sendCommandMessage(message);
  }

  async disconnect(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.teardown();
    this.listeners.emit({ type: "DISCONNECT", timestamp: this.now() });
    await this.peripheral.disconnect().catch(() => {});
  }
}

/** Connect to a GAN cube. The entry point `connectSmartCube` builds on. */
export async function connectGanCube(
  transport: BleTransport,
  options: GanConnectionOptions = {},
): Promise<GanConnection> {
  return GanConnection.open(transport, options);
}
