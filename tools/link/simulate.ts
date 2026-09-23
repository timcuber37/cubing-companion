/**
 * Compare the reference and eager recovery strategies over a simulated iPhone link.
 *
 * Run: npm run link-sim [-- <queue depth> [fast]]
 *
 * The model, calibrated to a session recorded on an iPhone 11 with a GAN i Carry 4:
 *
 * - **One notification per 45 ms connection event.** What the recording shows: frames arrive at
 *   45 ms spacing, with only occasional doubles.
 * - **A small queue on the cube that drops its oldest entry when full.** Consistent with the
 *   recording, where a move is lost while the one after it arrives. The depth is the knob: 2 loses
 *   about a tenth of frames, 3 about a hundredth. The real session lost 24% of its moves.
 * - **History answers queue behind moves**, so they cost the same scarce slots — the reason
 *   duplicate requests hurt.
 * - **An idle facelet report every second**, as the cube sends.
 * - **M-heavy algorithms**: half the turns are slices, two face turns 2–8 ms apart, with pauses of
 *   0.8–2.5 s between algorithms. `fast` turns 35–80 ms apart instead of 60–120, which saturates
 *   the link — the case that reproduced the multi-second holds seen on the phone.
 *
 * Both strategies play identical sessions, so only the recovery differs. Latency is from the turn
 * to the move's release by the driver, which is what the person holding the cube sees.
 */
import { GanGen4Driver } from "../../packages/cube-link/src/gan/gen4.ts";
import { REQUEST_REPEAT_MS, type RecoveryMode } from "../../packages/cube-link/src/gan/buffer.ts";
import type { GanDriverConnection, GanMoveEvent } from "../../packages/cube-link/src/gan/events.ts";
import { integer, seeded } from "../vectors/random.ts";

const INTERVAL_MS = 45;
const SESSIONS = 30;
const queueDepth = Number(process.argv[2] ?? 3);
const fast = process.argv[3] === "fast";
if (!Number.isInteger(queueDepth) || queueDepth < 1) {
  throw new Error(`queue depth must be a positive integer, not ${process.argv[2]}`);
}

const LIVE = [2, 32, 8, 1, 16, 4];
const HISTORY = [1, 5, 3, 0, 4, 2];
const R = 1, L = 4;

function setBits(bytes: Uint8Array, start: number, length: number, value: number): void {
  for (let i = 0; i < length; i++) {
    const bit = start + i;
    const mask = 0x80 >> (bit & 7);
    bytes[bit >> 3] = (value >> (length - 1 - i)) & 1 ? bytes[bit >> 3]! | mask : bytes[bit >> 3]! & ~mask;
  }
}
function littleEndian(bytes: Uint8Array, byte: number, count: number, value: number): void {
  for (let i = 0; i < count; i++) bytes[byte + i] = Math.floor(value / 256 ** i) & 0xff;
}

interface Turn { at: number; face: number; direction: number }

function session(random: () => number): Turn[] {
  const turns: Turn[] = [];
  let at = 500;
  while (at < 60_000) {
    for (let k = 0, n = integer(random, 6, 14); k < n; k++) {
      if (random() < 0.5) {
        // A slice: R and L the opposite way, a few milliseconds apart.
        const direction = integer(random, 0, 1);
        turns.push({ at, face: R, direction }, { at: at + integer(random, 2, 8), face: L, direction: 1 - direction });
      } else {
        turns.push({ at, face: integer(random, 0, 5), direction: integer(random, 0, 1) });
      }
      at += fast ? integer(random, 35, 80) : integer(random, 60, 120);
    }
    at += integer(random, 800, 2500);
  }
  return turns;
}

async function simulate(recovery: RecoveryMode, seed: number) {
  const turns = session(seeded(seed));
  let clock = 0;
  const driver = new GanGen4Driver(() => clock, recovery);
  const written: Uint8Array[] = [];
  const connection: GanDriverConnection = {
    sendCommandMessage: async (message) => void written.push(message),
    disconnect: async () => {},
  };
  const played = new Map<number, Turn>();
  const queue: Uint8Array[] = [];
  let serial = 100, next = 0, dropped = 0, requests = 0, lastReport = 0;
  const latencies: number[] = [];

  const enqueue = (frame: Uint8Array) => {
    queue.push(frame);
    if (queue.length > queueDepth) {
      queue.shift();
      dropped++;
    }
  };
  const report = () => {
    const frame = new Uint8Array(20);
    frame[0] = 0xed;
    frame[1] = 16;
    littleEndian(frame, 2, 2, serial);
    for (let i = 0; i < 7; i++) setBits(frame, 32 + i * 3, 3, i);
    for (let i = 0; i < 11; i++) setBits(frame, 69 + i * 4, 4, i);
    return frame;
  };

  await driver.handleStateEvent(connection, report());
  const end = turns[turns.length - 1]!.at + 4000;
  for (let event = INTERVAL_MS; event < end; event += INTERVAL_MS) {
    while (next < turns.length && turns[next]!.at <= event) {
      const turn = turns[next++]!;
      serial = (serial + 1) & 0xff;
      played.set(serial, turn);
      const frame = new Uint8Array(20);
      frame[0] = 0x01;
      frame[1] = 9;
      littleEndian(frame, 2, 4, turn.at);
      littleEndian(frame, 6, 2, serial);
      setBits(frame, 64, 2, turn.direction);
      setBits(frame, 66, 6, LIVE[turn.face]!);
      enqueue(frame);
    }
    if (event - lastReport >= 1000) {
      lastReport = event;
      enqueue(report());
    }
    // Requests written since the last event reach the cube now; its answers join the queue.
    for (const request of written.splice(0)) {
      if (request[0] !== 0xd1) continue;
      requests++;
      const start = request[2]!, count = Math.min(request[4]!, 34);
      const frame = new Uint8Array(20);
      frame[0] = 0xd1;
      frame[1] = Math.floor(count / 2) + 1;
      frame[2] = start;
      for (let i = 0; i < count; i++) {
        const turn = played.get((start - i) & 0xff);
        setBits(frame, 24 + 4 * i, 4, turn ? (HISTORY[turn.face]! << 1) | turn.direction : 0xf);
      }
      enqueue(frame);
    }
    clock = event;
    if (event % REQUEST_REPEAT_MS < INTERVAL_MS) await driver.retry(connection);
    const delivered = queue.shift();
    if (!delivered) continue;
    for (const e of await driver.handleStateEvent(connection, delivered)) {
      if (e.type === "MOVE") latencies.push(event - played.get((e as GanMoveEvent).serial)!.at);
    }
  }
  return { turns: turns.length, released: latencies.length, dropped, requests, latencies };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
console.log(`queue depth ${queueDepth}, ${fast ? "fast" : "normal"} turning, ${SESSIONS} sessions of a minute each`);
for (const recovery of ["reference", "eager"] as const) {
  let turns = 0, dropped = 0, requests = 0;
  const latencies: number[] = [];
  for (let seed = 1; seed <= SESSIONS; seed++) {
    const run = await simulate(recovery, seed * 7919);
    turns += run.turns;
    dropped += run.dropped;
    requests += run.requests;
    latencies.push(...run.latencies);
  }
  latencies.sort((a, b) => a - b);
  const slow = latencies.filter((l) => l > 300).length;
  console.log(
    `  ${recovery.padEnd(9)} ${latencies.length}/${turns} released · ${dropped} frames dropped · ${requests} requests · ` +
      `p50 ${percentile(latencies, 0.5)} ms · p95 ${percentile(latencies, 0.95)} ms · max ${latencies.at(-1)} ms · ` +
      `${(100 * slow / latencies.length).toFixed(1)}% over 300 ms`,
  );
}
