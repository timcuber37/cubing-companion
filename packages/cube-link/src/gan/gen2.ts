/**
 * Gen2 protocol driver.
 *
 * Cubes: GAN Mini ui FreePlay, GAN12 ui FreePlay, GAN12 ui, GAN356 i Carry S, GAN356 i Carry,
 * GAN356 i 3, Monster Go 3Ai.
 *
 * The oldest of the three and the odd one out: it has no move-history recovery, and instead packs
 * **up to seven recent moves into every move event**. A dropped packet is therefore usually
 * repaired by the next one, which is why this driver needs none of the buffering machinery the
 * later generations do.
 *
 * Vendored from `gan-web-bluetooth` (MIT, Andy Fedotov).
 */
import { faceletsEvent } from "./facelets.ts";
import { GanMessageView } from "./message.ts";
import {
  moveName,
  type GanCubeCommand,
  type GanCubeEvent,
  type GanDriverConnection,
  type GanProtocolDriver,
} from "./events.ts";

/** The cube batches at most this many moves into one event. */
const MAX_BATCHED_MOVES = 7;

export class GanGen2Driver implements GanProtocolDriver {
  private lastSerial = -1;
  private lastMoveTimestamp = 0;
  private cubeTimestamp = 0;

  constructor(private readonly now: () => number) {}

  createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
    const message = new Uint8Array(20).fill(0);
    switch (command.type) {
      case "REQUEST_FACELETS":
        message[0] = 0x04;
        return message;
      case "REQUEST_HARDWARE":
        message[0] = 0x05;
        return message;
      case "REQUEST_BATTERY":
        message[0] = 0x09;
        return message;
      case "REQUEST_RESET":
        message.set([
          0x0a, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
        ]);
        return message;
      default:
        return undefined;
    }
  }

  async handleStateEvent(
    connection: GanDriverConnection,
    message: Uint8Array,
  ): Promise<GanCubeEvent[]> {
    const timestamp = this.now();
    const events: GanCubeEvent[] = [];
    const view = new GanMessageView(message);
    const eventType = view.word(0, 4);

    if (eventType === 0x01) {
      // GYRO
      const qw = view.word(4, 16);
      const qx = view.word(20, 16);
      const qy = view.word(36, 16);
      const qz = view.word(52, 16);
      const vx = view.word(68, 4);
      const vy = view.word(72, 4);
      const vz = view.word(76, 4);
      events.push({
        type: "GYRO",
        timestamp,
        // Sign-magnitude, not two's complement: the top bit is the sign and the rest the value.
        quaternion: {
          x: signed15(qx),
          y: signed15(qy),
          z: signed15(qz),
          w: signed15(qw),
        },
        velocity: { x: signed3(vx), y: signed3(vy), z: signed3(vz) },
      });
    } else if (eventType === 0x02) {
      // MOVE — only trustworthy once a facelet report has told us where the serial started.
      if (this.lastSerial !== -1) {
        const serial = view.word(4, 8);
        const diff = Math.min((serial - this.lastSerial) & 0xff, MAX_BATCHED_MOVES);
        this.lastSerial = serial;

        if (diff > 0) {
          // Newest move is at index 0, so walk backwards to emit in chronological order.
          for (let i = diff - 1; i >= 0; i--) {
            const face = view.word(12 + 5 * i, 4);
            const direction = view.word(16 + 5 * i, 1);
            let elapsed = view.word(47 + 16 * i, 16);
            // The cube's 16-bit elapsed register wrapped; fall back to the host clock, which is
            // the only other measure of how long ago this was.
            if (elapsed === 0) elapsed = timestamp - this.lastMoveTimestamp;
            this.cubeTimestamp += elapsed;
            events.push({
              type: "MOVE",
              serial: (serial - i) & 0xff,
              timestamp,
              // Only the newest move in a batch actually arrived now; the rest are reconstructed.
              localTimestamp: i === 0 ? timestamp : null,
              cubeTimestamp: this.cubeTimestamp,
              face,
              direction,
              move: moveName(face, direction),
            });
          }
          this.lastMoveTimestamp = timestamp;
        }
      }
    } else if (eventType === 0x04) {
      // FACELETS
      const serial = view.word(4, 8);
      if (this.lastSerial === -1) this.lastSerial = serial;

      const cp: number[] = [];
      const co: number[] = [];
      const ep: number[] = [];
      const eo: number[] = [];
      for (let i = 0; i < 7; i++) {
        cp.push(view.word(12 + i * 3, 3));
        co.push(view.word(33 + i * 2, 2));
      }
      for (let i = 0; i < 11; i++) {
        ep.push(view.word(47 + i * 4, 4));
        eo.push(view.word(91 + i, 1));
      }
      const facelets = faceletsEvent(serial, timestamp, cp, co, ep, eo);
      // Dropped rather than thrown: a corrupted notification should not end the session.
      if (facelets) events.push(facelets);
    } else if (eventType === 0x05) {
      // HARDWARE
      const hwMajor = view.word(8, 8);
      const hwMinor = view.word(16, 8);
      const swMajor = view.word(24, 8);
      const swMinor = view.word(32, 8);
      let hardwareName = "";
      for (let i = 0; i < 8; i++) hardwareName += String.fromCharCode(view.word(i * 8 + 40, 8));
      events.push({
        type: "HARDWARE",
        timestamp,
        hardwareName,
        hardwareVersion: `${hwMajor}.${hwMinor}`,
        softwareVersion: `${swMajor}.${swMinor}`,
        gyroSupported: view.word(104, 1) !== 0,
      });
    } else if (eventType === 0x09) {
      events.push({ type: "BATTERY", timestamp, batteryLevel: Math.min(view.word(8, 8), 100) });
    } else if (eventType === 0x0d) {
      await connection.disconnect();
    }

    return events;
  }
}

/** 16-bit sign-magnitude to the range [-1, 1]. */
function signed15(value: number): number {
  return ((1 - (value >> 15) * 2) * (value & 0x7fff)) / 0x7fff;
}

/** 4-bit sign-magnitude. */
function signed3(value: number): number {
  return (1 - (value >> 3) * 2) * (value & 0x7);
}
