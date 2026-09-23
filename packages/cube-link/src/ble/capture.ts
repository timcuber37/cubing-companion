/**
 * Recording a GAN cube's raw protocol frames.
 *
 * The point of this is to get one real cube's bytes into the repository, so the protocol driver
 * can be vendored against something that actually happened rather than against a reading of
 * someone else's source. After that, decoding is regression-tested in CI forever — which is a
 * thing this project has never had. `GYRO_RESULTS.md` validated decoded *events*; it could not
 * validate the decoding, because by the time anything was observable the library had already done
 * it.
 *
 * **This capture is passive.** It subscribes and writes down what arrives. It cannot ask the cube
 * for anything, because every command is encrypted and the encoder does not exist yet — that is
 * the work this fixture is for. Turning the cube is the whole procedure.
 *
 * That turns out to cost less than expected. A Gen4 cube volunteers more than its moves: the
 * committed capture holds 1,063 move frames, 138 periodic facelet reports and 11 battery reports,
 * none of them requested. Only the true request/response paths — hardware info, move history
 * recovery, reset — are out of reach until there is an encoder to ask with.
 *
 * ## On the MAC address
 *
 * A capture **contains the cube's MAC address**, and has to: the frames are AES-encrypted with a
 * key salted from it, so without it the file is noise. This is a deliberate departure from
 * `diagnostics.ts`, which allowlists fields precisely to keep device identifiers out of its
 * export. Two different artifacts with two different contracts, kept apart on purpose rather than
 * by loosening the one that promised not to do this.
 *
 * A BLE MAC identifies a physical cube, not a person, and this export is something someone chooses
 * to produce and share. But it should be an informed choice, so the UI says so and the format name
 * does not pretend otherwise.
 */
import {
  BleTransportError,
  type BleTransport,
  type GanMacStore,
} from "./transport.ts";
import { GAN_COMPANY_IDS, GAN_NAME_PREFIXES, GAN_SERVICES, profileFor, type GanProtocol } from "./gan-uuids.ts";
import { resolveMac, type MacSource } from "./mac.ts";

export type CaptureStopReason = "manual" | "duration-limit" | "frame-limit" | "disconnected";

/** One notification, exactly as it came off the radio. */
export interface CapturedFrame {
  /** Milliseconds since capture start, on the host clock. */
  readonly atMs: number;
  /** Lowercase hex. Chosen over base64 so a diff of a fixture is readable byte by byte. */
  readonly hex: string;
}

export interface CaptureSummary {
  readonly state: "recording" | "stopped";
  readonly stopReason: CaptureStopReason | null;
  readonly protocol: GanProtocol;
  readonly frames: number;
  readonly bytes: number;
  readonly durationMs: number;
  /** Distinct frame lengths seen. A protocol that only ever sends one size is worth noticing. */
  readonly frameSizes: readonly number[];
  readonly macSource: MacSource;
}

export interface ProtocolCapture {
  readonly format: "cubing-companion.gan-protocol-capture";
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly protocol: GanProtocol;
  readonly service: string;
  readonly stateCharacteristic: string;
  readonly deviceName: string | null;
  /**
   * The cube's MAC. Required to derive the decryption key — see the note at the top of this file.
   */
  readonly mac: string;
  readonly macSource: MacSource;
  readonly notes: string;
  readonly limits: { readonly maxFrames: number; readonly maxDurationMs: number };
  readonly stopReason: CaptureStopReason | null;
  readonly durationMs: number;
  readonly frames: readonly CapturedFrame[];
}

export interface CaptureOptions {
  readonly store?: GanMacStore;
  readonly prompt?: () => Promise<string | null>;
  /** Free text from whoever recorded it: which cube, what they did. Goes into the fixture. */
  readonly notes?: string;
  readonly maxFrames?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
  readonly wallNow?: () => number;
}

const DEFAULT_MAX_FRAMES = 20_000;
const DEFAULT_MAX_DURATION_MS = 300_000;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Parse a capture's frames back to bytes, for replay through {@link FakeTransport}. */
export function framesToBytes(capture: ProtocolCapture): Uint8Array[] {
  return capture.frames.map((frame) => {
    if (frame.hex.length % 2 !== 0 || /[^0-9a-f]/i.test(frame.hex)) {
      throw new BleTransportError(`frame at ${frame.atMs}ms is not valid hex`);
    }
    const bytes = new Uint8Array(frame.hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(frame.hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  });
}

/** A capture in progress. */
export class ProtocolCaptureSession {
  private readonly frames: CapturedFrame[] = [];
  private readonly sizes = new Set<number>();
  private reason: CaptureStopReason | null = null;
  private stoppedAt: number | null = null;
  private bytes = 0;
  private unsubscribe: (() => void) | null = null;
  private dropped: (() => void) | null = null;

  constructor(
    private readonly origin: number,
    readonly startedAt: string,
    readonly protocol: GanProtocol,
    readonly service: string,
    readonly stateCharacteristic: string,
    readonly deviceName: string | null,
    private readonly mac: string,
    private readonly macSource: MacSource,
    private readonly notes: string,
    private readonly maxFrames: number,
    private readonly maxDurationMs: number,
    private readonly now: () => number,
  ) {}

  /** @internal wired by {@link captureProtocolFrames}. */
  attach(unsubscribe: () => void, dropped: () => void): void {
    this.unsubscribe = unsubscribe;
    this.dropped = dropped;
  }

  /** @internal */
  receive(data: Uint8Array, receivedAt: number): void {
    if (this.reason !== null) return;
    const atMs = receivedAt - this.origin;
    if (atMs >= this.maxDurationMs) {
      this.stop("duration-limit");
      return;
    }
    this.frames.push({ atMs, hex: hex(data) });
    this.sizes.add(data.byteLength);
    this.bytes += data.byteLength;
    if (this.frames.length >= this.maxFrames) this.stop("frame-limit");
  }

  /** @internal */
  onDropped(): void {
    this.stop("disconnected");
  }

  stop(reason: CaptureStopReason = "manual"): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.stoppedAt = this.now();
    this.unsubscribe?.();
    this.unsubscribe = null;
    // A capture that ended because the cube vanished should not then try to hang up on it.
    if (reason !== "disconnected") this.dropped?.();
    this.dropped = null;
  }

  private get durationMs(): number {
    return (this.stoppedAt ?? this.now()) - this.origin;
  }

  summary(): CaptureSummary {
    return {
      state: this.reason === null ? "recording" : "stopped",
      stopReason: this.reason,
      protocol: this.protocol,
      frames: this.frames.length,
      bytes: this.bytes,
      durationMs: this.durationMs,
      frameSizes: [...this.sizes].sort((a, b) => a - b),
      macSource: this.macSource,
    };
  }

  export(): ProtocolCapture {
    return {
      format: "cubing-companion.gan-protocol-capture",
      schemaVersion: 1,
      startedAt: this.startedAt,
      protocol: this.protocol,
      service: this.service,
      stateCharacteristic: this.stateCharacteristic,
      deviceName: this.deviceName,
      mac: this.mac,
      macSource: this.macSource,
      notes: this.notes,
      limits: { maxFrames: this.maxFrames, maxDurationMs: this.maxDurationMs },
      stopReason: this.reason,
      durationMs: this.durationMs,
      frames: [...this.frames],
    };
  }
}

/**
 * Connect to a cube and start recording what it says.
 *
 * Must be called from a user gesture on platforms that require one for their device chooser.
 */
export async function captureProtocolFrames(
  transport: BleTransport,
  options: CaptureOptions = {},
): Promise<ProtocolCaptureSession> {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;

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

    const session = new ProtocolCaptureSession(
      now(),
      new Date(wallNow()).toISOString(),
      profile.protocol,
      profile.service,
      profile.stateCharacteristic,
      peripheral.name,
      mac,
      source,
      options.notes ?? "",
      options.maxFrames ?? DEFAULT_MAX_FRAMES,
      options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      now,
    );

    const stopWatchingDisconnect = peripheral.onDisconnect(() => session.onDropped());
    const unsubscribe = await peripheral.subscribe(
      profile.service,
      profile.stateCharacteristic,
      (data, receivedAt) => session.receive(data, receivedAt),
    );

    session.attach(
      () => {
        unsubscribe();
        stopWatchingDisconnect();
      },
      () => void peripheral.disconnect().catch(() => {}),
    );

    return session;
  } catch (error) {
    // Anything that fails after connecting leaves a live radio link behind otherwise.
    await peripheral.disconnect().catch(() => {});
    throw error;
  }
}
