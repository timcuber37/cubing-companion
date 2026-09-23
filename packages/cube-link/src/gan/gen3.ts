/**
 * Gen3 protocol driver.
 *
 * Cubes: GAN356 i Carry 2.
 *
 * Byte-aligned and framed — every message opens with a `0x55` magic byte, a type and a length —
 * where Gen2 packs bitfields from the first nibble. One move per event, with the gaps recovered by
 * asking, which is what {@link BufferedMoveDriver} is for.
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

/** Every Gen3 message starts with this, and anything else is not one. */
const MAGIC = 0x55;

/** The protocol's own face numbering in history responses, which differs from the live one. */
const HISTORY_FACE_ORDER = [1, 5, 3, 0, 4, 2];
/** Live move events encode the face as a one-hot bitmask in this order. */
const MOVE_FACE_ORDER = [2, 32, 8, 1, 16, 4];

export class GanGen3Driver extends BufferedMoveDriver implements GanProtocolDriver {
  createCommandMessage(command: GanCubeCommand): Uint8Array | undefined {
    const message = new Uint8Array(16).fill(0);
    switch (command.type) {
      case "REQUEST_FACELETS":
        message.set([0x68, 0x01]);
        return message;
      case "REQUEST_HARDWARE":
        message.set([0x68, 0x04]);
        return message;
      case "REQUEST_BATTERY":
        message.set([0x68, 0x07]);
        return message;
      case "REQUEST_RESET":
        message.set([
          0x68, 0x05, 0x05, 0x39, 0x77, 0x00, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
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
    const message = new Uint8Array(16).fill(0);
    message.set([0x68, 0x03, window.serial, 0, window.count, 0]);
    // A failed write is not worth surfacing: the request is reissued on the next move event.
    await connection.sendCommandMessage(message).catch(() => {});
  }

  async handleStateEvent(
    connection: GanDriverConnection,
    message: Uint8Array,
  ): Promise<GanCubeEvent[]> {
    const timestamp = this.now();
    let events: GanCubeEvent[] = [];
    const view = new GanMessageView(message);

    const magic = view.word(0, 8);
    const eventType = view.word(8, 8);
    const dataLength = view.word(16, 8);
    if (magic !== MAGIC || dataLength === 0) return events;

    if (eventType === 0x01) {
      // MOVE — ignored until a facelet report has established the serial.
      if (this.lastSerial !== -1) {
        this.lastLocalTimestamp = timestamp;
        const cubeTimestamp = view.word(24, 32, true);
        const serial = (this.serial = view.word(56, 16, true));
        const direction = view.word(72, 2);
        const face = MOVE_FACE_ORDER.indexOf(view.word(74, 6));

        if (face >= 0) {
          this.moveBuffer.push({
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
    } else if (eventType === 0x06) {
      // MOVE_HISTORY — the answer to a gap, newest first.
      const startSerial = view.word(24, 8);
      const count = (dataLength - 1) * 2;
      for (let i = 0; i < count; i++) {
        const face = HISTORY_FACE_ORDER.indexOf(view.word(32 + 4 * i, 3));
        const direction = view.word(35 + 4 * i, 1);
        if (face < 0) continue;
        this.injectMissedMove({
          type: "MOVE",
          serial: (startSerial - i) & 0xff,
          timestamp,
          // A recovered move was never received, so it has neither a host nor a cube time.
          localTimestamp: null,
          cubeTimestamp: null,
          face,
          direction,
          move: moveName(face, direction),
        });
      }
      // No connection: this *is* the history response, and asking again would not help.
      events = await this.evictMoveBuffer();
    } else if (eventType === 0x02) {
      // FACELETS, sent periodically as well as on request.
      const serial = (this.serial = view.word(24, 16, true));

      if (this.lastSerial !== -1) {
        // Debounced: mid-solve the stream is busy and a gap is probably just in flight.
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
        cp.push(view.word(40 + i * 3, 3));
        co.push(view.word(61 + i * 2, 2));
      }
      for (let i = 0; i < 11; i++) {
        ep.push(view.word(77 + i * 4, 4));
        eo.push(view.word(121 + i, 1));
      }
      const facelets = faceletsEvent(serial, timestamp, cp, co, ep, eo);
      // Dropped rather than thrown: a corrupted notification should not end the session.
      if (facelets) events.push(facelets);
    } else if (eventType === 0x07) {
      const swMajor = view.word(72, 4);
      const swMinor = view.word(76, 4);
      const hwMajor = view.word(80, 4);
      const hwMinor = view.word(84, 4);
      let hardwareName = "";
      for (let i = 0; i < 5; i++) hardwareName += String.fromCharCode(view.word(i * 8 + 32, 8));
      events.push({
        type: "HARDWARE",
        timestamp,
        hardwareName,
        hardwareVersion: `${hwMajor}.${hwMinor}`,
        softwareVersion: `${swMajor}.${swMinor}`,
        // The i Carry 2 has no gyroscope.
        gyroSupported: false,
      });
    } else if (eventType === 0x10) {
      events.push({ type: "BATTERY", timestamp, batteryLevel: Math.min(view.word(24, 8), 100) });
    } else if (eventType === 0x11) {
      await connection.disconnect();
    }

    return events;
  }
}
