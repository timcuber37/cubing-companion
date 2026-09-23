/**
 * Move ordering and gap recovery, shared by the Gen3 and Gen4 drivers.
 *
 * A cube numbers its moves 0–255 and wraps. BLE loses packets, so the host sees gaps — 21 of them
 * in the 137-second capture committed as a fixture, about 2% of moves. The cube remembers what it
 * sent, so a gap can be filled by asking for history; the awkward part is that the answer arrives
 * later, out of order, and must be slotted into a stream that has kept moving meanwhile.
 *
 * Hence a FIFO that only releases moves once they are contiguous. A move whose predecessor is
 * missing waits, a history request goes out, and the recovered moves are pushed onto the head of
 * the buffer in reverse. If the buffer grows past 16 the cube is hung up on, because at that point
 * something is wrong that another request will not fix.
 *
 * Vendored from `gan-web-bluetooth` (MIT, Andy Fedotov). The reference carries two near-identical
 * copies of this, one per generation; they are the same algorithm and are shared here. What
 * differs between generations is the *layout* of the history request, which stays abstract.
 */
import type { GanCubeEvent, GanDriverConnection, GanMoveEvent } from "./events.ts";

/** Past this, gap recovery is not working and the connection is the problem. */
const MAX_PENDING = 16;

export abstract class BufferedMoveDriver {
  /** Serial of the newest move seen, from any source. */
  protected serial = -1;
  /** Serial of the newest move actually released downstream. */
  protected lastSerial = -1;
  protected lastLocalTimestamp: number | null = null;
  protected readonly moveBuffer: GanMoveEvent[] = [];

  constructor(protected readonly now: () => number) {}

  /** Ask the cube to resend `count` moves ending at `serial`. Layout differs per generation. */
  protected abstract requestMoveHistory(
    connection: GanDriverConnection,
    serial: number,
    count: number,
  ): Promise<void>;

  /**
   * Release moves from the head of the buffer while they are contiguous.
   *
   * Stops at the first gap and asks for history, when there is a connection to ask through —
   * there is not when this is called while *processing* a history response, which would otherwise
   * request history recursively forever.
   */
  protected async evictMoveBuffer(connection?: GanDriverConnection): Promise<GanCubeEvent[]> {
    const evicted: GanCubeEvent[] = [];

    while (this.moveBuffer.length > 0) {
      const head = this.moveBuffer[0]!;
      const diff = this.lastSerial === -1 ? 1 : (head.serial - this.lastSerial) & 0xff;
      if (diff > 1) {
        if (connection) await this.requestMoveHistory(connection, head.serial, diff);
        break;
      }
      evicted.push(this.moveBuffer.shift()!);
      this.lastSerial = head.serial;
    }

    if (connection && this.moveBuffer.length > MAX_PENDING) {
      await connection.disconnect();
    }
    return evicted;
  }

  /**
   * Does `serial` fall between `start` and `end`, counting around the 256 wrap?
   *
   * Open at both ends by default: the endpoints are moves already accounted for, and only what is
   * strictly between them is missing.
   */
  protected isSerialInRange(
    start: number,
    end: number,
    serial: number,
    closedStart = false,
    closedEnd = false,
  ): boolean {
    return (
      ((end - start) & 0xff) >= ((serial - start) & 0xff) &&
      (closedStart || ((start - serial) & 0xff) > 0) &&
      (closedEnd || ((end - serial) & 0xff) > 0)
    );
  }

  /**
   * Slot a recovered move into the buffer, if it is genuinely one of the missing ones.
   *
   * History responses arrive newest-first and may overlap what is already held, so this is picky
   * on purpose: a duplicate or an out-of-range serial is dropped rather than corrupting the order.
   */
  protected injectMissedMove(move: GanMoveEvent): void {
    if (this.moveBuffer.length > 0) {
      const head = this.moveBuffer[0]!;
      if (this.moveBuffer.some((event) => event.serial === move.serial)) return;
      if (!this.isSerialInRange(this.lastSerial, head.serial, move.serial)) return;
      if (move.serial === ((head.serial - 1) & 0xff)) this.moveBuffer.unshift(move);
      return;
    }
    // An empty buffer means the gap was noticed from a periodic facelet report rather than from a
    // move that arrived after it.
    if (this.isSerialInRange(this.lastSerial, this.serial, move.serial, false, true)) {
      this.moveBuffer.unshift(move);
    }
  }

  /** On a periodic facelet report: has anything gone missing since the last released move? */
  protected async checkIfMoveMissed(connection: GanDriverConnection): Promise<void> {
    const diff = (this.serial - this.lastSerial) & 0xff;
    if (diff === 0) return;
    // Serial 0 is skipped: a firmware bug makes the facelet report at the 255→0 wrap unreliable.
    if (this.serial === 0) return;
    const head = this.moveBuffer[0];
    const startSerial = head ? head.serial : (this.serial + 1) & 0xff;
    await this.requestMoveHistory(connection, startSerial, diff + 1);
  }

  /**
   * Align a history request to what the firmware will actually answer.
   *
   * Responses are byte-aligned and always begin at an odd serial with an even number of moves, so
   * an unaligned request silently returns something else. The window is also clamped so it cannot
   * cross the 255→0 edge, where the moves come back spoofed as zero bytes.
   */
  protected alignHistoryWindow(serial: number, count: number): { serial: number; count: number } {
    let start = serial;
    let length = count;
    if (start % 2 === 0) start = (start - 1) & 0xff;
    if (length % 2 === 1) length++;
    return { serial: start, count: Math.min(length, start + 1) };
  }
}
