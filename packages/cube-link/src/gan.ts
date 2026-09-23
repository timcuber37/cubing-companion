/**
 * A GAN smart cube, presented as a {@link CubeSource}.
 *
 * This file is the adapter: it turns decoded cube events into the move stream the rest of the
 * project consumes, and it is the only part of the package that knows a cube is a GAN. Below it
 * are two layers it deliberately does not mix with — `ble/` moves bytes over a radio, `gan/`
 * decodes them — and above it nothing knows either exists.
 *
 * The protocol used to come from `gan-web-bluetooth`, chosen over cubing.js's `cubing/bluetooth`
 * because cubing.js polls on an interval, which quantises every move timestamp to the poll period
 * and destroys the precision A3 measures. That reasoning still holds; the library is now the
 * *reference* rather than a dependency, because it reaches for `navigator.bluetooth` directly and
 * so cannot run where there is no Web Bluetooth. See `src/gan/` and `MOBILE_PLAN.md`.
 *
 * Which radios are available is now a property of the transport passed in, not of this file. In a
 * browser that means Chromium — Chrome and Edge on desktop, Chrome on Android — because Web
 * Bluetooth does not exist on Safari or iOS.
 */
import {
  CubeState,
  fromFacelets,
  makeMove,
  type Move,
} from "@cubing-companion/engine";
import {
  Listeners,
  type CubeSource,
  type MoveEvent,
  type Unsubscribe,
} from "./source.ts";
import { isWebBluetoothAvailable } from "./ble/web.ts";
import type { BleTransport, GanMacStore } from "./ble/transport.ts";

/**
 * Supplies the cube's MAC address.
 *
 * GAN cubes encrypt their traffic with a key derived from the MAC, and Web Bluetooth
 * deliberately does not expose it. The library recovers it automatically where the platform
 * allows; where it cannot, it asks. Expect this to be the most common first-run snag.
 *
 * Return `null` to let the library keep trying its own methods.
 */
export type MacAddressPrompt = (
  device: { name?: string | undefined },
  isRetry: boolean,
) => Promise<string | null>;

export interface GanCubeSourceOptions {
  readonly macAddressPrompt?: MacAddressPrompt;
  /** The radio. Defaults to Web Bluetooth; a native shell supplies its own. */
  readonly transport?: BleTransport;
  /**
   * Where to remember each device's MAC address.
   *
   * Worth persisting rather than leaving to the default in-memory store: a reconnect produces no
   * advertisement and therefore no decryption key, so forgetting means the cube has to be paired
   * again. See `ble/mac.ts`.
   */
  readonly macStore?: GanMacStore;
}

/**
 * Whether this browser can talk to a smart cube at all.
 *
 * Lives in `ble/web.ts` rather than being duplicated here, so that file stays the only one in the
 * package that touches `navigator` — which `test/boundaries.test.ts` enforces, and which is what
 * makes swapping the radio a matter of supplying a different transport.
 */
export { isWebBluetoothAvailable };

export class SmartCubeError extends Error {
  override readonly name = "SmartCubeError";
}

/**
 * Translate a GAN move string into an engine move.
 *
 * The protocol only ever emits outer-face quarter turns — it builds them as
 * `"URFDLB"[face] + " '"[direction]` — so this is a narrow mapping by construction. It is
 * still validated rather than trusted, because a protocol change should fail loudly instead
 * of silently applying the wrong turn.
 */
export function parseGanMove(raw: string): Move {
  const text = raw.trim();
  const family = text[0];
  const suffix = text.slice(1);

  // Deliberately narrower than the engine's notation: the engine understands rotations,
  // wide moves and slices, but a cube cannot sense any of them. Accepting an `x` here
  // would mean a protocol misunderstanding had quietly injected a rotation into the
  // tracked state, which is precisely the silent corruption worth refusing.
  if (
    family === undefined ||
    !"URFDLB".includes(family) ||
    (suffix !== "" && suffix !== "'")
  ) {
    throw new SmartCubeError(
      `unrecognised move from cube: ${JSON.stringify(raw)} (expected an outer-face quarter turn)`,
    );
  }

  const move = makeMove(family, suffix === "'" ? -1 : 1);
  if (move === undefined || move === null) {
    throw new SmartCubeError(`unrecognised move family from cube: ${JSON.stringify(raw)}`);
  }
  return move;
}

/**
 * The subset of `gan-web-bluetooth`'s connection that this adapter uses.
 *
 * Declared structurally so tests can supply a fake, and so a breaking change in the library
 * surfaces here as a type error rather than at runtime on your desk.
 */
export interface GanConnectionLike {
  deviceName?: string;
  /** Best-effort diagnostics only; this is not part of the library's public interface. */
  stateCharacteristic?: { uuid?: string; service?: { uuid?: string } };
  events$: {
    subscribe(observer: (event: GanEventLike) => void): { unsubscribe(): void };
  };
  sendCubeCommand(command: { type: string }): Promise<void>;
  disconnect(): Promise<void>;
}

export type GanEventLike =
  | {
      type: "MOVE";
      serial: number;
      move: string;
      cubeTimestamp: number | null;
      localTimestamp: number | null;
    }
  | { type: "FACELETS"; serial: number; facelets: string }
  | { type: "GYRO"; timestamp?: number; quaternion: { x: number; y: number; z: number; w: number }; velocity?: { x: number; y: number; z: number } }
  | {
      type: "HARDWARE";
      hardwareName?: string;
      hardwareVersion?: string;
      softwareVersion?: string;
      gyroSupported?: boolean;
    }
  | { type: "DISCONNECT" }
  | { type: string; [key: string]: unknown };

/**
 * What the cube says about itself, once it has said it.
 *
 * The advertised gyro flag is advisory: some library versions use an incomplete model
 * whitelist. Diagnostics compare it with received samples instead of gating capture on it.
 */
export interface GanHardwareInfo {
  readonly hardwareName: string | null;
  readonly hardwareVersion: string | null;
  readonly softwareVersion: string | null;
  /** `null` until the cube has reported, which it does shortly after connecting. */
  readonly gyroSupported: boolean | null;
}

/**
 * The revision of the reference implementation this protocol was vendored from.
 *
 * No longer a runtime dependency — `src/gan/` decodes the protocol itself — but recorded in
 * diagnostics as provenance, and pinned by a test against the installed devDependency. Upgrading
 * that package therefore fails the build, which is the intended prompt to re-run the differential
 * test in `test/protocol.test.ts` and see what changed upstream.
 */
export const GAN_LIBRARY_VERSION = "3.0.2";

export interface GanTransportInfo {
  readonly libraryVersion: string;
  readonly serviceUuid: string | null;
  readonly stateCharacteristicUuid: string | null;
  readonly protocol: "gen2" | "gen3" | "gen4" | "unknown";
}

export interface GanDiagnosticPacket {
  /** Host arrival at the adapter, not a device sample timestamp. */
  readonly receivedAt: number;
  readonly event: GanEventLike;
}

/**
 * A GAN smart cube presented as a {@link CubeSource}.
 *
 * Construct via {@link connectSmartCube}, or directly with a connection for testing.
 */
export class GanCubeSource implements CubeSource {
  readonly kind = "smart-cube" as const;

  private readonly connection: GanConnectionLike;
  private readonly moveListeners = new Listeners<MoveEvent>();
  private readonly disconnectListeners = new Listeners<void>();
  private readonly subscription: { unsubscribe(): void };
  /** Resolvers waiting on a FACELETS reply. */
  private pendingState: ((state: CubeState) => void)[] = [];
  private latestState: CubeState | null = null;
  private connected = true;
  private hardware: GanHardwareInfo | null = null;
  private readonly hardwareListeners = new Listeners<GanHardwareInfo>();
  private readonly diagnosticListeners = new Listeners<GanDiagnosticPacket>();

  constructor(connection: GanConnectionLike) {
    this.connection = connection;
    this.subscription = connection.events$.subscribe((event) =>
      this.handleEvent(event),
    );
  }

  get name(): string | null {
    return this.connection.deviceName ?? null;
  }

  onMove(listener: (event: MoveEvent) => void) {
    return this.moveListeners.add(listener);
  }

  onDisconnect(listener: () => void) {
    return this.disconnectListeners.add(listener);
  }

  /**
   * Ask the cube for its current facelets.
   *
   * The protocol is fire-and-forget — the reply arrives as a FACELETS event — so this
   * bridges the command and the event back into a promise.
   */
  async queryState(): Promise<CubeState> {
    if (!this.connected) {
      throw new SmartCubeError("cube is disconnected");
    }
    const wait = new Promise<CubeState>((resolve) => {
      this.pendingState.push(resolve);
    });
    await this.connection.sendCubeCommand({ type: "REQUEST_FACELETS" });
    return wait;
  }

  /**
   * Tell the cube it is solved, re-basing the state it tracks internally.
   *
   * The cube keeps its own idea of the position from its sensors, and it can be wrong — turned
   * while asleep, or a fast half turn read as a quarter. When it is, nothing downstream can
   * recover: reading its position faithfully reports the mistake, because the mistake is what
   * the cube believes. The only fix is to put a solved cube in your hand and say so.
   *
   * Destructive in the sense that it discards whatever the cube thought: only call it when the
   * cube really is solved.
   */
  async resetToSolved(): Promise<void> {
    if (!this.connected) {
      throw new SmartCubeError("cube is disconnected");
    }
    await this.connection.sendCubeCommand({ type: "REQUEST_RESET" });
  }

  /** The most recent state the cube reported, without a round trip. */
  lastKnownState(): CubeState | null {
    return this.latestState?.clone() ?? null;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.subscription.unsubscribe();
    await this.connection.disconnect();
    this.disconnectListeners.emit();
  }

  /** What the cube reported about itself, or `null` before it has. */
  getHardware(): GanHardwareInfo | null {
    return this.hardware;
  }

  /** Fires once the cube describes itself, which happens shortly after connecting. */
  onHardware(listener: (info: GanHardwareInfo) => void): Unsubscribe {
    if (this.hardware) listener(this.hardware);
    return this.hardwareListeners.add(listener);
  }

  /** Raw decoded events for opt-in diagnostics, kept out of the canonical move stream. */
  onDiagnostic(listener: (packet: GanDiagnosticPacket) => void): Unsubscribe {
    return this.diagnosticListeners.add(listener);
  }

  getTransportInfo(): GanTransportInfo {
    // Inspect only UUIDs; never expose the connection object, device MAC, or crypto keys.
    const uuid = (value: unknown) => typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase() : null;
    const serviceUuid = uuid(this.connection.stateCharacteristic?.service?.uuid);
    const protocols = new Map<string, GanTransportInfo["protocol"]>([
      ["6e400001-b5a3-f393-e0a9-e50e24dc4179", "gen2"],
      ["8653000a-43e6-47b7-9cb0-5fc21d4ae340", "gen3"],
      ["00000010-0000-fff7-fff6-fff5fff4fff0", "gen4"],
    ]);
    return {
      libraryVersion: GAN_LIBRARY_VERSION,
      serviceUuid,
      stateCharacteristicUuid: uuid(this.connection.stateCharacteristic?.uuid),
      protocol: serviceUuid === null ? "unknown" : protocols.get(serviceUuid) ?? "unknown",
    };
  }

  /** Read-only request. A successful write does not guarantee a hardware reply. */
  async requestHardware(): Promise<void> {
    if (!this.connected) throw new SmartCubeError("cube is disconnected");
    await this.connection.sendCubeCommand({ type: "REQUEST_HARDWARE" });
  }

  private handleEvent(event: GanEventLike): void {
    if (!this.connected) return;
    this.diagnosticListeners.emit({ event, receivedAt: performance.now() });
    switch (event.type) {
      case "MOVE": {
        const move = event as Extract<GanEventLike, { type: "MOVE" }>;
        this.moveListeners.emit({
          move: parseGanMove(move.move),
          serial: move.serial,
          cubeTimestamp: move.cubeTimestamp,
          localTimestamp: move.localTimestamp,
        });
        break;
      }
      case "FACELETS": {
        const facelets = (event as Extract<GanEventLike, { type: "FACELETS" }>)
          .facelets;
        // The cube reports facelets in the standard Kociemba layout, which is exactly why
        // that is the interchange format — GAN's own piece indexing differs from ours.
        const state = fromFacelets(facelets);
        this.latestState = state;
        for (const resolve of this.pendingState.splice(0)) resolve(state.clone());
        break;
      }
      case "HARDWARE": {
        const info = event as Extract<GanEventLike, { type: "HARDWARE" }>;
        this.hardware = {
          hardwareName: info.hardwareName ?? null,
          hardwareVersion: info.hardwareVersion ?? null,
          softwareVersion: info.softwareVersion ?? null,
          gyroSupported: info.gyroSupported ?? null,
        };
        this.hardwareListeners.emit(this.hardware);
        break;
      }
      case "DISCONNECT": {
        if (this.connected) {
          this.connected = false;
          this.disconnectListeners.emit();
        }
        break;
      }
      default:
        break; // Gyro remains diagnostic-only; it is never applied as a face turn.
    }
  }
}

/**
 * Prompt for a smart cube and connect to it.
 *
 * Must be called from a user gesture on platforms that require one for their device chooser —
 * Web Bluetooth will not show its own otherwise.
 *
 * `transport` is what makes this portable. It defaults to Web Bluetooth, which is the only radio
 * available in a browser; a native shell passes its own, and nothing else in the package changes.
 * The protocol underneath is vendored — see `src/gan/` — so there is no longer a third-party
 * library reaching for `navigator.bluetooth` behind this call.
 *
 * The import stays lazy. Not for the old reason (a CommonJS `aes-js` that made this module
 * unloadable under Node's ESM loader — that is gone with the vendoring), but because the crypto
 * and protocol code is dead weight for the many visitors who never connect a cube.
 */
export async function connectSmartCube(
  options: GanCubeSourceOptions = {},
): Promise<GanCubeSource> {
  const { transport, macAddressPrompt, macStore } = options;

  const radio = transport ?? new (await import("./ble/web.ts")).WebBluetoothTransport();
  if (!(await radio.isAvailable())) {
    throw new SmartCubeError(
      radio.kind === "web-bluetooth"
        ? "Web Bluetooth is unavailable. Smart cubes need Chrome or Edge on desktop, or Chrome on Android; Safari and iOS do not support it."
        : "No Bluetooth radio is available.",
    );
  }

  const { connectGanCube } = await import("./gan/connection.ts");
  const connection = await connectGanCube(radio, {
    ...(macStore === undefined ? {} : { store: macStore }),
    // The prompt is now genuinely a last resort: a scan carries the address on every platform
    // that can scan, so this fires only where the advertisement was missed entirely.
    ...(macAddressPrompt === undefined
      ? {}
      : { prompt: () => macAddressPrompt({ name: connectionName(radio) }, true) }),
  });
  return new GanCubeSource(connection as unknown as GanConnectionLike);
}

/** The chooser has not returned a device yet when the prompt fires, so there is no name to give. */
function connectionName(_transport: BleTransport): string | undefined {
  return undefined;
}
