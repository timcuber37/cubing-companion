/**
 * Gen4 protocol driver.
 *
 * Cubes: GAN12 ui Maglev, GAN14 ui FreePlay, GAN i Carry 4.
 *
 * **This is the one with a fixture behind it.** `test/fixtures/gan-gen4-frames.json` is 137 seconds
 * of a real i Carry 4, and `test/protocol.test.ts` decodes it here and checks the result against
 * the reference implementation, frame for frame. The other two generations are verified against
 * the reference over generated messages; this one is additionally verified against a cube.
 *
 * Structurally Gen3 without the magic byte, and with hardware information split across four
 * separate messages that have to be collected before anything can be reported.
 *
 * Vendored from `gan-web-bluetooth` (MIT, Andy Fedotov).
 */
import { BufferedMoveDriver } from "./buffer.ts";
import { faceletsEvent } from "./facelets.ts";
import { GanMessageView } from "./message.ts";
import {
  moveName,
  type GanCubeCommand,
  type GanCubeEvent,
  type GanDriverConnection,
  type GanProtocolDriver,
} from "./events.ts";

const HISTORY_FACE_ORDER = [1, 5, 3, 0, 4, 2];
const MOVE_FACE_ORDER = [2, 32, 8, 1, 16, 4];

/** Hardware information arrives in four messages; all four are needed before reporting. */
const HW_PRODUCT_DATE = 0xfa;
const HW_NAME = 0xfc;
const HW_SOFTWARE = 0xfd;
const HW_HARDWARE = 0xfe;

/** The only Gen4 cube with a gyroscope. The i Carry 4 in particular does not have one. */
const GYRO_MODELS = ["GAN12uiM"];

export class GanGen4Driver extends BufferedMoveDriver implements GanProtocolDriver {
  private hardware: Record<number, string> = {};

  createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
    const message = new Uint8Array(20).fill(0);
    switch (command.type) {
      case "REQUEST_FACELETS":
        message.set([0xdd, 0x04, 0x00, 0xed, 0x00, 0x00]);
        return message;
      case "REQUEST_HARDWARE":
        // Reset first: the reply is four messages and a stale partial set would report early.
        this.hardware = {};
        message.set([0xdf, 0x03, 0x00, 0x00, 0x00]);
        return message;
      case "REQUEST_BATTERY":
        message.set([0xdd, 0x04, 0x00, 0xef, 0x00, 0x00]);
        return message;
      case "REQUEST_RESET":
        message.set([
          0xd2, 0x0d, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
        ]);
        return message;
      default:
        return undefined;
    }
  }

  protected override async requestMoveHistory(
    connection: GanDriverConnection,
    serial: number,
    count: number,
  ): Promise<void> {
    const window = this.alignHistoryWindow(serial, count);
    const message = new Uint8Array(20).fill(0);
    message.set([0xd1, 0x04, window.serial, 0, window.count, 0]);
    await connection.sendCommandMessage(message).catch(() => {});
  }

  async handleStateEvent(
    connection: GanDriverConnection,
    message: Uint8Array,
  ): Promise<GanCubeEvent[]> {
    const timestamp = this.now();
    let events: GanCubeEvent[] = [];
    const view = new GanMessageView(message);

    const eventType = view.word(0, 8);
    const dataLength = view.word(8, 8);

    if (eventType === 0x01) {
      // MOVE
      if (this.lastSerial !== -1) {
        this.lastLocalTimestamp = timestamp;
        const cubeTimestamp = view.word(16, 32, true);
        // Read as 16 bits little-endian to match the reference. The high byte is zero across all
        // 1,063 move frames of the committed capture — the serial is really 8-bit — and every
        // comparison downstream masks with 0xFF, so the two readings agree in practice.
        const serial = (this.serial = view.word(48, 16, true));
        const direction = view.word(64, 2);
        const face = MOVE_FACE_ORDER.indexOf(view.word(66, 6));

        if (face >= 0) {
          this.acceptLiveMove({
            type: "MOVE",
            serial,
            timestamp,
            localTimestamp: timestamp,
            cubeTimestamp,
            face,
            direction,
            move: moveName(face, direction),
          });
        }
        events = await this.evictMoveBuffer(connection);
      }
    } else if (eventType === 0xd1) {
      // MOVE_HISTORY
      const startSerial = view.word(16, 8);
      const count = (dataLength - 1) * 2;
      for (let i = 0; i < count; i++) {
        const face = HISTORY_FACE_ORDER.indexOf(view.word(24 + 4 * i, 3));
        const direction = view.word(27 + 4 * i, 1);
        if (face < 0) continue;
        this.injectMissedMove({
          type: "MOVE",
          serial: (startSerial - i) & 0xff,
          timestamp,
          localTimestamp: null,
          cubeTimestamp: null,
          face,
          direction,
          move: moveName(face, direction),
        });
      }
      events = await this.evictMoveBuffer();
      await this.afterHistory(connection, events);
    } else if (eventType === 0xed) {
      // FACELETS — 138 of these arrived unprompted in the committed capture.
      const serial = (this.serial = view.word(16, 16, true));

      if (this.lastSerial !== -1) {
        if (this.lastLocalTimestamp !== null && timestamp - this.lastLocalTimestamp > 500) {
          await this.checkIfMoveMissed(connection);
        }
      }
      if (this.lastSerial === -1) this.lastSerial = serial;

      const cp: number[] = [];
      const co: number[] = [];
      const ep: number[] = [];
      const eo: number[] = [];
      for (let i = 0; i < 7; i++) {
        cp.push(view.word(32 + i * 3, 3));
        co.push(view.word(53 + i * 2, 2));
      }
      for (let i = 0; i < 11; i++) {
        ep.push(view.word(69 + i * 4, 4));
        eo.push(view.word(113 + i, 1));
      }
      const facelets = faceletsEvent(serial, timestamp, cp, co, ep, eo);
      // Dropped rather than thrown: a corrupted notification should not end the session.
      if (facelets) events.push(facelets);
    } else if (eventType >= HW_PRODUCT_DATE && eventType <= HW_HARDWARE) {
      this.collectHardware(eventType, dataLength, view);
      if (Object.keys(this.hardware).length === 4) {
        const name = this.hardware[HW_NAME]!;
        events.push({
          type: "HARDWARE",
          timestamp,
          hardwareName: name,
          hardwareVersion: this.hardware[HW_HARDWARE]!,
          softwareVersion: this.hardware[HW_SOFTWARE]!,
          productDate: this.hardware[HW_PRODUCT_DATE]!,
          gyroSupported: GYRO_MODELS.includes(name),
        });
      }
    } else if (eventType === 0xec) {
      // GYRO
      const qw = view.word(16, 16);
      const qx = view.word(32, 16);
      const qy = view.word(48, 16);
      const qz = view.word(64, 16);
      const vx = view.word(80, 4);
      const vy = view.word(84, 4);
      const vz = view.word(88, 4);
      events.push({
        type: "GYRO",
        timestamp,
        quaternion: { x: signed15(qx), y: signed15(qy), z: signed15(qz), w: signed15(qw) },
        velocity: { x: signed3(vx), y: signed3(vy), z: signed3(vz) },
      });
    } else if (eventType === 0xef) {
      // BATTERY — the level sits past the declared payload, not inside it.
      events.push({
        type: "BATTERY",
        timestamp,
        batteryLevel: Math.min(view.word(8 + dataLength * 8, 8), 100),
      });
    } else if (eventType === 0xea) {
      await connection.disconnect();
    }

    return events;
  }

  private collectHardware(eventType: number, dataLength: number, view: GanMessageView): void {
    switch (eventType) {
      case HW_PRODUCT_DATE: {
        const year = view.word(24, 16, true);
        const month = view.word(40, 8);
        const day = view.word(48, 8);
        this.hardware[eventType] =
          `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
        break;
      }
      case HW_NAME: {
        let name = "";
        for (let i = 0; i < dataLength - 1; i++) {
          name += String.fromCharCode(view.word(i * 8 + 24, 8));
        }
        this.hardware[eventType] = name;
        break;
      }
      case HW_SOFTWARE:
      case HW_HARDWARE:
        this.hardware[eventType] = `${view.word(24, 4)}.${view.word(28, 4)}`;
        break;
    }
  }
}

function signed15(value: number): number {
  return ((1 - (value >> 15) * 2) * (value & 0x7fff)) / 0x7fff;
}

function signed3(value: number): number {
  return (1 - (value >> 3) * 2) * (value & 0x7);
}
