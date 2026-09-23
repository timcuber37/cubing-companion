/**
 * What a cube says, decoded.
 *
 * Shaped to match `gan-web-bluetooth`'s event objects field for field, deliberately: `gan.ts`
 * already consumes that shape through its structural {@link GanEventLike}, the adapter and its
 * tests need no changes, and `test/protocol.test.ts` can compare the vendored drivers against the
 * reference by deep equality rather than by a translation layer that could hide a difference.
 */

export type GanCommandType =
  | "REQUEST_FACELETS"
  | "REQUEST_HARDWARE"
  | "REQUEST_BATTERY"
  | "REQUEST_RESET";

export interface GanCubeCommand {
  readonly type: GanCommandType;
}

export interface GanMoveEvent {
  readonly type: "MOVE";
  /** Wraps at 256. A gap means the host missed packets — see the move buffer in `buffer.ts`. */
  readonly serial: number;
  readonly timestamp: number;
  /**
   * Host clock at arrival, or null for a move recovered from history rather than received.
   *
   * Null is not a defect to paper over: a recovered move genuinely has no arrival time, and
   * `timeline.ts` needs to know which timestamps it can fit against.
   */
  readonly localTimestamp: number | null;
  /** The cube's own clock. Null on recovered moves, for the same reason. */
  readonly cubeTimestamp: number | null;
  readonly face: number;
  readonly direction: number;
  /** `"R"` or `"R'"`. Quarter turns of outer faces only — the protocol has nothing else. */
  readonly move: string;
}

export interface GanFaceletsEvent {
  readonly type: "FACELETS";
  readonly serial: number;
  readonly timestamp: number;
  readonly facelets: string;
  readonly state: {
    readonly CP: number[];
    readonly CO: number[];
    readonly EP: number[];
    readonly EO: number[];
  };
}

export interface GanGyroEvent {
  readonly type: "GYRO";
  readonly timestamp: number;
  readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
  readonly velocity?: { readonly x: number; readonly y: number; readonly z: number };
}

export interface GanBatteryEvent {
  readonly type: "BATTERY";
  readonly timestamp: number;
  readonly batteryLevel: number;
}

export interface GanHardwareEvent {
  readonly type: "HARDWARE";
  readonly timestamp: number;
  readonly hardwareName: string;
  readonly hardwareVersion: string;
  readonly softwareVersion: string;
  readonly productDate?: string;
  readonly gyroSupported: boolean;
}

export interface GanDisconnectEvent {
  readonly type: "DISCONNECT";
  readonly timestamp: number;
}

export type GanCubeEvent =
  | GanMoveEvent
  | GanFaceletsEvent
  | GanGyroEvent
  | GanBatteryEvent
  | GanHardwareEvent
  | GanDisconnectEvent;

/** What a driver needs from its connection: a way to ask, and a way to give up. */
export interface GanDriverConnection {
  sendCommandMessage(message: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
}

export interface GanProtocolDriver {
  createCommandMessage(command: GanCubeCommand): Uint8Array | undefined;
  handleStateEvent(
    connection: GanDriverConnection,
    message: Uint8Array,
  ): Promise<GanCubeEvent[]>;
  /** Called on a timer by the connection; see `BufferedMoveDriver.retry`. */
  retry?(connection: GanDriverConnection): Promise<void>;
}

/** Face order in the protocol's own numbering. */
export const FACE_NAMES = "URFDLB";

/** `"R"` or `"R'"` from a face index and a direction bit. */
export function moveName(face: number, direction: number): string {
  return (FACE_NAMES.charAt(face) + " '".charAt(direction)).trim();
}
