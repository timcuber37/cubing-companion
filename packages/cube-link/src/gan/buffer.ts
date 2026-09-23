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

/**
 * How a driver recovers lost moves.
 *
 * - `"reference"` — exactly as `gan-web-bluetooth` does, and the default, so the differential test
 *   in `test/protocol.test.ts` keeps comparing like with like.
 * - `"eager"` — what the apps use. Measured on an iPhone, where the link carries about one
 *   notification per 45 ms connection event and fast slice algorithms lost a quarter of their moves,
 *   the reference strategy held moves for seconds at the end of a burst, for three reasons:
 *
 *   1. After an answer fills one gap it asks for nothing more — a guard against re-requesting
 *      forever — so a second gap waits for the next move or the cube's idle facelet report, about a
 *      second later. Eager asks again at once, provided the answer made progress.
 *   2. It only recovers moves *below* the first one it holds, so a move lost after it waits a further
 *      report cycle. Eager accepts any move up to the newest serial the cube has reported.
 *   3. It repeats the same request on every move while a gap is open, and each repeat draws a
 *      duplicate answer that takes one of those scarce notification slots — one session sent 102
 *      requests for 59 recoveries. Eager does not repeat an identical request inside
 *      {@link REQUEST_REPEAT_MS}, and retries on a timer through `retry` instead — so an answer
 *      that is itself dropped is still asked for again during a pause, when no move arrives to
 *      prompt it.
 *
 * In a simulated saturated link the reference strategy held 65–89% of moves for over 300 ms, with a
 * 95th percentile of 5–10 seconds; eager held 9–17%, with a 95th percentile under half a second.
 */
export type RecoveryMode = "reference" | "eager";

/**
 * How long an identical history request is held back, and how often the connection calls
 * {@link BufferedMoveDriver.retry}.
 *
 * Chosen by simulation (`npm run link-sim`), not by reasoning: the link is modelled as one
 * notification per 45 ms connection event with a small queue on the cube that drops its oldest
 * entry, calibrated to a recorded iPhone session. De-duplication cuts duplicate answers, which
 * matters when the link is saturated; but under heavy loss the answers are themselves dropped, and
 * then repeats are what recover them. 250 ms was worse than the reference strategy under heavy
 * loss; 60–100 ms with a timer was better than it everywhere tested, and 100 ms had the best tail
 * when turning faster than the link can carry.
 */
export const REQUEST_REPEAT_MS = 100;

export abstract class BufferedMoveDriver {
  /** Serial of the newest move seen, from any source. */
  protected serial = -1;
  /** Serial of the newest move actually released downstream. */
  protected lastSerial = -1;
  protected lastLocalTimestamp: number | null = null;
  protected readonly moveBuffer: GanMoveEvent[] = [];

  /** The last history request, so an identical one is not repeated while its answer is due. */
  private lastRequest: { serial: number; count: number; at: number } | null = null;

  constructor(
    protected readonly now: () => number,
    protected readonly recovery: RecoveryMode = "reference",
  ) {}

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
        if (connection) {
          if (this.recovery === "eager") await this.requestMissing(connection);
          else await this.requestMoveHistory(connection, head.serial, diff);
        }
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
    if (this.recovery === "eager") {
      if (this.lastSerial === -1) return;
      const ahead = (move.serial - this.lastSerial) & 0xff;
      // Released already, or beyond anything the cube has said it played.
      if (ahead === 0 || ahead > ((this.serial - this.lastSerial) & 0xff)) return;
      if (this.moveBuffer.some((event) => event.serial === move.serial)) return;
      // In serial order, wherever it falls — not only just below the first held move.
      const index = this.moveBuffer.findIndex(
        (event) => ((event.serial - this.lastSerial) & 0xff) > ahead,
      );
      this.moveBuffer.splice(index === -1 ? this.moveBuffer.length : index, 0, move);
      return;
    }
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
    if (this.recovery === "eager") return this.requestMissing(connection);
    const head = this.moveBuffer[0];
    const startSerial = head ? head.serial : (this.serial + 1) & 0xff;
    await this.requestMoveHistory(connection, startSerial, diff + 1);
  }

  /**
   * A live move, arriving in its own notification.
   *
   * Eager recovery can fetch a move from history before its own late notification turns up, so in
   * that mode a move already held or already released is a duplicate and is dropped — applying it
   * twice would desynchronise the tracker.
   */
  protected acceptLiveMove(move: GanMoveEvent): void {
    if (this.recovery === "eager" && this.lastSerial !== -1) {
      const ahead = (move.serial - this.lastSerial) & 0xff;
      if (ahead === 0 || ahead > 0x80) return;
      if (this.moveBuffer.some((event) => event.serial === move.serial)) return;
    }
    this.moveBuffer.push(move);
  }

  /**
   * Ask again for anything still missing, if the last request has gone unanswered too long.
   *
   * For eager recovery, called by the connection on a timer. The reference strategy retries by
   * repeating its request on every incoming move, which under heavy loss doubles as a retry for an
   * answer that was itself dropped; eager does not repeat, so without this a dropped answer would
   * wait for the next idle facelet report. A no-op in reference mode, and when nothing is missing.
   */
  async retry(connection: GanDriverConnection): Promise<void> {
    if (this.recovery !== "eager" || this.lastSerial === -1) return;
    const missing = this.moveBuffer.length > 0 || ((this.serial - this.lastSerial) & 0xff) !== 0;
    if (missing) await this.requestMissing(connection);
  }

  /** After a history answer: in eager mode, ask straight away for whatever is still missing. */
  protected async afterHistory(
    connection: GanDriverConnection,
    released: readonly GanCubeEvent[],
  ): Promise<void> {
    // Only after progress: an answer that filled nothing would otherwise be re-requested forever.
    if (this.recovery === "eager" && released.length > 0) await this.requestMissing(connection);
  }

  /**
   * Ask for the earliest run of missing moves, unless that exact request is already awaiting its
   * answer.
   *
   * The run ends just below the first held move, or — when nothing is held — at the newest serial
   * the cube has reported. Arguments follow the reference's convention: the serial just above the
   * run, and the run's length plus one.
   */
  private async requestMissing(connection: GanDriverConnection): Promise<void> {
    if (this.lastSerial === -1) return;
    const head = this.moveBuffer[0];
    const above = head ? head.serial : (this.serial + 1) & 0xff;
    const count = (above - this.lastSerial) & 0xff;
    if (count <= 1) return;

    const window = this.alignHistoryWindow(above, count);
    const at = this.now();
    const last = this.lastRequest;
    if (
      last && last.serial === window.serial && last.count === window.count &&
      at - last.at < REQUEST_REPEAT_MS
    ) {
      return;
    }
    this.lastRequest = { ...window, at };
    await this.requestMoveHistory(connection, above, count);
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
