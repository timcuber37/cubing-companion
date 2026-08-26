/**
 * GAN smart cube over Web Bluetooth.
 *
 * Wraps `gan-web-bluetooth`, which was chosen over cubing.js's built-in `cubing/bluetooth`
 * for one decisive reason: cubing.js drives GAN cubes by polling on an interval, which
 * quantises every move timestamp to the poll period and destroys the timing precision A3
 * needs. This library is notification-driven and surfaces the cube's own clock.
 *
 * Everything protocol-specific is confined to this file. The rest of the package sees only
 * {@link CubeSource}.
 *
 * Browser support is Chromium-only — Chrome and Edge on desktop, Chrome on Android. Web
 * Bluetooth does not exist on Safari or on iOS at all.
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
}

/** Whether this browser can talk to a smart cube at all. */
export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as { bluetooth?: unknown }).bluetooth !== "undefined"
  );
}

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
 * Worth surfacing rather than discarding, because `gyroSupported` decides whether whole-cube
 * rotations are observable at all. A rotation turns no face against the core, so it produces no
 * move event on any smart cube; the orientation sensor is the only thing that could see one, and
 * only some protocol generations report it. Which one a given cube speaks is decided by its BLE
 * service UUID, not by its name, so the honest way to find out is to ask the cube.
 */
export interface GanHardwareInfo {
  readonly hardwareName: string | null;
  readonly hardwareVersion: string | null;
  readonly softwareVersion: string | null;
  /** `null` until the cube has reported, which it does shortly after connecting. */
  readonly gyroSupported: boolean | null;
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

  private handleEvent(event: GanEventLike): void {
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
        break; // GYRO and BATTERY are not used here.
    }
  }
}

/**
 * Prompt for a smart cube and connect to it.
 *
 * Must be called from a user gesture: Web Bluetooth will not show its device chooser
 * otherwise.
 *
 * The library is imported lazily rather than at module load. Three reasons, all of them
 * real: it pulls in `aes-js`, which is CommonJS and breaks Node's ESM loader, so a static
 * import would make this module unimportable in tests; it never runs during server
 * rendering; and it keeps the BLE and crypto code out of the initial bundle for the many
 * visitors who never connect a cube.
 */
export async function connectSmartCube(
  options: GanCubeSourceOptions = {},
): Promise<GanCubeSource> {
  if (!isWebBluetoothAvailable()) {
    throw new SmartCubeError(
      "Web Bluetooth is unavailable. Smart cubes need Chrome or Edge on desktop, or Chrome on Android; Safari and iOS do not support it.",
    );
  }

  const { connectGanCube } = await import("gan-web-bluetooth");
  const { macAddressPrompt } = options;
  const connection = await connectGanCube(
    macAddressPrompt
      ? (device, isFallbackCall) =>
          macAddressPrompt({ name: device.name }, isFallbackCall === true)
      : undefined,
  );
  return new GanCubeSource(connection as unknown as GanConnectionLike);
}
