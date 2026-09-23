/**
 * The cube link: GAN protocol, clock fitting and state tracking, for S3 of `SWIFT_PLAN.md`.
 *
 * Unlike the other corpora this one is not a list of independent (input, expected) pairs. The
 * drivers are stateful — they buffer moves, remember serials, ask the cube for history and read a
 * clock — so a case is a *replay*: a sequence of frames fed in order, with what came out after each
 * one. A port that decodes every frame correctly in isolation but mishandles the order still fails.
 *
 * Six kinds of case:
 *
 * - `crypto` — the committed 1,213-frame capture of a real i Carry 4, encrypted and decrypted, and
 *   every command encrypted under both the GAN and the MoYu key.
 * - `commands` — each generation's command messages.
 * - `decode` — random payloads under every event type, per generation, replayed in sequence. The
 *   paths two minutes of real solving never reach, and the only coverage Gen2 and Gen3 get.
 * - `capture` — the real capture through the Gen4 driver, with the arrival times it was recorded at.
 * - `recovery` — a simulated cube that drops frames and *answers* the history requests the driver
 *   sends, under both recovery modes (see `RecoveryMode` in `buffer.ts`). The committed capture has
 *   no history responses at all, so this is the only place gap recovery is exercised end to end.
 * - `mac`, `timeline`, `tracker` — MAC recovery from advertisements, the least-squares clock fit,
 *   and the tracker's desync handling.
 *
 * Everything stays scalar: hex strings, notation, numbers. The Swift side needs no TypeScript types
 * to read it.
 */
import {
  applyMoves,
  CubeState,
  makeMove,
  toFacelets,
  type Move,
} from "@cubing-companion/engine";
import CAPTURE from "../../packages/cube-link/test/fixtures/gan-gen4-frames.json" with { type: "json" };
import { GanGen2Driver } from "../../packages/cube-link/src/gan/gen2.ts";
import { GanGen3Driver } from "../../packages/cube-link/src/gan/gen3.ts";
import { GanGen4Driver } from "../../packages/cube-link/src/gan/gen4.ts";
import { encrypterFor } from "../../packages/cube-link/src/gan/crypto.ts";
import { REQUEST_REPEAT_MS, type RecoveryMode } from "../../packages/cube-link/src/gan/buffer.ts";
import type {
  GanCubeCommand,
  GanCubeEvent,
  GanDriverConnection,
  GanProtocolDriver,
} from "../../packages/cube-link/src/gan/events.ts";
import { macFromAdvertisement } from "../../packages/cube-link/src/ble/mac.ts";
import { framesToBytes, type ProtocolCapture } from "../../packages/cube-link/src/ble/capture.ts";
import { MoveTimeline } from "../../packages/cube-link/src/timeline.ts";
import { CubeTracker } from "../../packages/cube-link/src/tracker.ts";
import type { CubeSource, MoveEvent } from "../../packages/cube-link/src/source.ts";
import { integer, pick, seeded } from "./random.ts";
import type { VectorFile } from "./cases.ts";

const capture = CAPTURE as ProtocolCapture;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Events as plain JSON: `undefined` fields dropped, exactly as the file will hold them. */
const plain = (events: readonly GanCubeEvent[]): unknown[] => JSON.parse(JSON.stringify(events));

type Generation = "gen2" | "gen3" | "gen4";

function driverFor(
  generation: Generation,
  now: () => number,
  recovery: RecoveryMode = "reference",
): GanProtocolDriver {
  switch (generation) {
    case "gen2":
      return new GanGen2Driver(now);
    case "gen3":
      return new GanGen3Driver(now, recovery);
    case "gen4":
      return new GanGen4Driver(now, recovery);
  }
}

/** A connection that records what the driver sent, so command traffic is part of the oracle. */
function recorder() {
  const sent: string[] = [];
  let disconnects = 0;
  const connection: GanDriverConnection = {
    async sendCommandMessage(message) {
      sent.push(hex(message));
    },
    async disconnect() {
      disconnects++;
    },
  };
  return {
    connection,
    /** Everything sent since the last call, and whether the driver hung up meanwhile. */
    drain() {
      const out = { sent: sent.splice(0), disconnects };
      disconnects = 0;
      return out;
    },
  };
}

interface Step {
  readonly now: number;
  readonly hex: string;
}

/** Feed frames in order; record what came out after each. */
async function replay(generation: Generation, steps: readonly Step[]) {
  let clock = 0;
  const driver = driverFor(generation, () => clock);
  const io = recorder();
  const out = [];
  for (const step of steps) {
    clock = step.now;
    const events = await driver.handleStateEvent(io.connection, bytesOf(step.hex));
    const { sent, disconnects } = io.drain();
    out.push({ now: step.now, hex: step.hex, events: plain(events), sent, disconnects });
  }
  return out;
}

const bytesOf = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const COMMANDS: readonly GanCubeCommand[] = [
  { type: "REQUEST_FACELETS" },
  { type: "REQUEST_HARDWARE" },
  { type: "REQUEST_BATTERY" },
  { type: "REQUEST_RESET" },
];

// MARK: - crypto and commands

function cryptoCase() {
  const encrypter = encrypterFor(capture.deviceName, capture.mac);
  const moyuMac = "12:34:56:78:9A:BC";
  const moyu = encrypterFor("AiCube-Test", moyuMac);
  const commands = (["gen2", "gen3", "gen4"] as const).flatMap((generation) =>
    COMMANDS.map((command) => {
      const message = driverFor(generation, () => 0).createCommandMessage(command)!;
      return {
        generation,
        command: command.type,
        plain: hex(message),
        gan: hex(encrypter.encrypt(message)),
        moyu: hex(moyu.encrypt(message)),
      };
    }),
  );
  return {
    kind: "crypto",
    deviceName: capture.deviceName,
    mac: capture.mac,
    moyuName: "AiCube-Test",
    moyuMac,
    frames: framesToBytes(capture).map((frame) => ({
      encrypted: hex(frame),
      decrypted: hex(encrypter.decrypt(frame)),
    })),
    commands,
  };
}

// MARK: - generated messages

/** Where each generation keeps its event type, and the types it knows. */
const LAYOUTS: Readonly<Record<Generation, {
  size: number;
  types: readonly number[];
  compose: (type: number, payload: Uint8Array) => Uint8Array;
}>> = {
  gen2: {
    size: 20,
    types: [0x01, 0x02, 0x04, 0x05, 0x09, 0x0d],
    compose: (type, payload) => {
      payload[0] = ((type & 0x0f) << 4) | (payload[0]! & 0x0f);
      return payload;
    },
  },
  gen3: {
    size: 16,
    types: [0x01, 0x02, 0x06, 0x07, 0x10, 0x11],
    compose: (type, payload) => {
      payload[0] = 0x55;
      payload[1] = type;
      payload[2] = Math.max(1, payload[2]! & 0x07);
      return payload;
    },
  },
  gen4: {
    size: 20,
    types: [0x01, 0xd1, 0xed, 0xfa, 0xfc, 0xfd, 0xfe, 0xec, 0xef, 0xea],
    compose: (type, payload) => {
      payload[0] = type;
      payload[1] = Math.max(1, payload[1]! & 0x07);
      return payload;
    },
  },
};

/** Bit offsets of the four piece arrays in each generation's facelet report. */
const PIECES: Readonly<Record<Generation, { type: number; cp: number; co: number; ep: number; eo: number }>> = {
  gen2: { type: 0x04, cp: 12, co: 33, ep: 47, eo: 91 },
  gen3: { type: 0x02, cp: 40, co: 61, ep: 77, eo: 121 },
  gen4: { type: 0xed, cp: 32, co: 53, ep: 69, eo: 113 },
};

function shuffled(random: () => number, size: number): number[] {
  const values = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = integer(random, 0, i);
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}

/**
 * Write a genuine cube state over a facelet report's piece fields.
 *
 * Random bytes almost never form a valid permutation, so without this the corpus would exercise
 * only the rejection path — and Gen2's conversion, which has no simulated cube behind it, would
 * never be seen producing a facelet string at all.
 */
function plantPieces(generation: Generation, random: () => number, message: Uint8Array): void {
  const at = PIECES[generation];
  const cp = shuffled(random, 8);
  const ep = shuffled(random, 12);
  for (let i = 0; i < 7; i++) {
    setBits(message, at.cp + i * 3, 3, cp[i]!);
    setBits(message, at.co + i * 2, 2, integer(random, 0, 2));
  }
  for (let i = 0; i < 11; i++) {
    setBits(message, at.ep + i * 4, 4, ep[i]!);
    setBits(message, at.eo + i, 1, integer(random, 0, 1));
  }
}

async function decodeCase(generation: Generation, random: () => number, perType: number) {
  const layout = LAYOUTS[generation];
  const steps: Step[] = [];
  let now = 0;
  // Interleaved rather than grouped by type, so state carried between messages — serials, the
  // move buffer, collected hardware fields — is exercised across event types too.
  for (let i = 0; i < perType * layout.types.length; i++) {
    const payload = Uint8Array.from({ length: layout.size }, () => Math.floor(random() * 256));
    const type = pick(random, layout.types);
    const message = layout.compose(type, payload);
    if (type === PIECES[generation].type && random() < 0.5) plantPieces(generation, random, message);
    now += 1 + Math.floor(random() * 40);
    steps.push({ now, hex: hex(message) });
  }
  return { kind: "decode", generation, steps: await replay(generation, steps) };
}

// MARK: - the real capture

async function captureCase() {
  const encrypter = encrypterFor(capture.deviceName, capture.mac);
  const frames = framesToBytes(capture);
  // Whole milliseconds: the clock is an input here, and an integer cannot be mis-parsed.
  const steps = frames.map((frame, i) => ({
    now: Math.round(capture.frames[i]!.atMs),
    hex: hex(encrypter.decrypt(frame)),
  }));
  return { kind: "capture", generation: "gen4", steps: await replay("gen4", steps) };
}

// MARK: - a cube that answers

/** MSB-first bit writer, the inverse of `GanMessageView.word`. */
function setBits(bytes: Uint8Array, start: number, length: number, value: number): void {
  for (let i = 0; i < length; i++) {
    const bit = start + i;
    const on = (value >> (length - 1 - i)) & 1;
    bytes[bit >> 3] = on ? bytes[bit >> 3]! | (0x80 >> (bit & 7)) : bytes[bit >> 3]! & ~(0x80 >> (bit & 7));
  }
}
function setLittleEndian(bytes: Uint8Array, bitStart: number, byteCount: number, value: number): void {
  for (let i = 0; i < byteCount; i++) bytes[bitStart / 8 + i] = Math.floor(value / 256 ** i) & 0xff;
}

const LIVE_FACE = [2, 32, 8, 1, 16, 4];
const HISTORY_FACE = [1, 5, 3, 0, 4, 2];

/** Frame layouts for the two generations that recover gaps by asking. */
const FRAMES = {
  gen3: {
    size: 16,
    header: (bytes: Uint8Array, type: number, length: number) => {
      bytes[0] = 0x55;
      bytes[1] = type;
      bytes[2] = length;
    },
    move: { type: 0x01, cubeTimestamp: 24, serial: 56, direction: 72, face: 74 },
    history: { type: 0x06, request: 0x03, start: 24, nibbles: 32, capacity: 24 },
    facelets: { type: 0x02, serial: 24, cp: 40, co: 61, ep: 77, eo: 121 },
  },
  gen4: {
    size: 20,
    header: (bytes: Uint8Array, type: number, length: number) => {
      bytes[0] = type;
      bytes[1] = length;
    },
    move: { type: 0x01, cubeTimestamp: 16, serial: 48, direction: 64, face: 66 },
    history: { type: 0xd1, request: 0xd1, start: 16, nibbles: 24, capacity: 34 },
    facelets: { type: 0xed, serial: 16, cp: 32, co: 53, ep: 69, eo: 113 },
  },
} as const;

/**
 * Play random moves on a simulated cube, drop some, and answer the history requests that causes.
 *
 * Answers sometimes arrive late — after one or two further moves — because that is when the
 * buffer's out-of-order insertion matters. Occasional pauses end in an unprompted facelet report,
 * which is how the driver notices moves lost at the *end* of a burst, with nothing after them.
 */
async function recoveryCase(
  generation: "gen3" | "gen4",
  random: () => number,
  moveCount: number,
  recovery: RecoveryMode = "reference",
) {
  const f = FRAMES[generation];
  let clock = 0;
  const driver = driverFor(generation, () => clock, recovery);
  const io = recorder();

  const start = integer(random, 0, 255);
  let serial = start;
  let cubeTime = integer(random, 0, 100_000);
  const history = new Map<number, { face: number; direction: number }>();

  const frame = () => new Uint8Array(f.size);
  const faceletsFrame = () => {
    const bytes = frame();
    f.header(bytes, f.facelets.type, 16);
    setLittleEndian(bytes, f.facelets.serial, 2, serial);
    // Reports solved: the driver validates and converts, but does not compare against its moves.
    for (let i = 0; i < 7; i++) setBits(bytes, f.facelets.cp + i * 3, 3, i);
    for (let i = 0; i < 11; i++) setBits(bytes, f.facelets.ep + i * 4, 4, i);
    return bytes;
  };
  const moveFrame = (s: number, face: number, direction: number) => {
    const bytes = frame();
    f.header(bytes, f.move.type, 9);
    setLittleEndian(bytes, f.move.cubeTimestamp, 4, cubeTime);
    setLittleEndian(bytes, f.move.serial, 2, s);
    setBits(bytes, f.move.direction, 2, direction);
    setBits(bytes, f.move.face, 6, LIVE_FACE[face]!);
    return bytes;
  };
  const historyFrame = (requestStart: number, count: number) => {
    const bytes = frame();
    const moves = Math.min(count, f.history.capacity);
    f.header(bytes, f.history.type, Math.floor(moves / 2) + 1);
    setBits(bytes, f.history.start, 8, requestStart);
    for (let i = 0; i < moves; i++) {
      const known = history.get((requestStart - i) & 0xff);
      // A serial the cube never played reads as face code 7, which no decoder accepts.
      const nibble = known ? (HISTORY_FACE[known.face]! << 1) | known.direction : 0x0f;
      setBits(bytes, f.history.nibbles + 4 * i, 4, nibble);
    }
    return bytes;
  };

  const steps: unknown[] = [];
  const pending: Uint8Array[] = [];
  let nextTick = 0;
  const queueAnswers = (sent: readonly string[]) => {
    for (const request of sent) {
      // Gen3 asks with `68 03 serial 00 count 00`, Gen4 with `d1 04 serial 00 count 00`.
      const message = bytesOf(request);
      const isHistory = generation === "gen3"
        ? message[0] === 0x68 && message[1] === f.history.request
        : message[0] === f.history.request;
      if (isHistory) pending.push(historyFrame(message[2]!, message[4]!));
    }
  };
  const feed = async (bytes: Uint8Array) => {
    // Eager recovery also runs on a timer; replay its ticks between frames, recorded as steps of
    // their own, so the port is checked on when the timer asks as well as on what frames decode to.
    if (recovery === "eager") {
      const arrived = clock;
      while (nextTick <= arrived) {
        clock = nextTick;
        nextTick += REQUEST_REPEAT_MS;
        await driver.retry?.(io.connection);
        const { sent, disconnects } = io.drain();
        steps.push({ now: clock, tick: true, events: [], sent, disconnects });
        queueAnswers(sent);
      }
      clock = arrived;
    }
    const events = await driver.handleStateEvent(io.connection, bytes);
    const { sent, disconnects } = io.drain();
    steps.push({ now: clock, hex: hex(bytes), events: plain(events), sent, disconnects });
    queueAnswers(sent);
  };

  /**
   * Answer outstanding requests within a connection interval or two, as a real cube does — but
   * sometimes only after the next move has arrived, which is when the buffer's out-of-order
   * insertion is exercised. An earlier version answered at most one request per move; the driver
   * re-requests on every move while a gap persists, so the answers fell ever further behind and
   * the buffer overflowed. That measured the simulation, not the driver.
   */
  const answer = async () => {
    while (pending.length > 0) {
      if (random() < 0.2) return;
      clock += integer(random, 10, 40);
      await feed(pending.shift()!);
    }
  };

  clock = 1000;
  nextTick = clock + REQUEST_REPEAT_MS;
  await feed(faceletsFrame());
  for (let k = 0; k < moveCount; k++) {
    const pause = random() < 0.08;
    const gap = pause ? integer(random, 600, 1500) : integer(random, 60, 220);
    clock += gap;
    cubeTime += gap + integer(random, -3, 3);
    serial = (serial + 1) & 0xff;
    const face = integer(random, 0, 5);
    const direction = integer(random, 0, 1);
    history.set(serial, { face, direction });

    if (random() >= 0.08) await feed(moveFrame(serial, face, direction));
    await answer();
    if (pause || random() < 0.03) {
      clock += integer(random, 510, 900);
      await feed(faceletsFrame());
      await answer();
    }
  }
  // Drain: answer everything outstanding, then one last report so trailing drops are noticed.
  for (let round = 0; round < 4 && (pending.length > 0 || round === 0); round++) {
    while (pending.length > 0) {
      clock += 30;
      await feed(pending.shift()!);
    }
    clock += 700;
    await feed(faceletsFrame());
  }
  return { kind: "recovery", generation, recovery, start, steps };
}

// MARK: - MAC, timeline, tracker

function macCase(random: () => number) {
  const cases = [];
  for (let i = 0; i < 60; i++) {
    const gan = random() < 0.7;
    const companyId = gan ? (integer(random, 0, 255) << 8) | 0x01 : integer(random, 0, 0xffff) & ~0x01 | 0x02;
    const length = random() < 0.15 ? integer(random, 0, 5) : integer(random, 6, 12);
    const payload = Uint8Array.from({ length }, () => integer(random, 0, 255));
    const mac = macFromAdvertisement({
      deviceId: "test",
      name: "GANtest",
      manufacturerData: new Map([[companyId, payload]]),
      serviceUuids: [],
      rssi: null,
    });
    cases.push({ companyId, payload: hex(payload), mac });
  }
  return { kind: "mac", cases };
}

const FAMILIES = ["U", "R", "F", "D", "L", "B"];
const randomMove = (random: () => number): Move =>
  makeMove(pick(random, FAMILIES), random() < 0.5 ? 1 : -1)!;
const notation = (move: Move) => `${move.family}${move.amount === -1 ? "'" : ""}`;

function timelineCase(random: () => number, index: number) {
  const length = integer(random, 2, 120);
  // A tenth of moves recovered from history, in some cases: no clock of either kind.
  const recoveredRate = pick(random, [0, 0, 0.1, 0.3]);
  // Gen2 batches: only the last move of a batch gets a host arrival time.
  const batched = random() < 0.25;
  const skew = 1 + (random() - 0.5) * 0.04;
  const offset = integer(random, 1000, 100_000);
  const windowSize = index % 5 === 0 ? integer(random, 2, 12) : undefined;

  const events: MoveEvent[] = [];
  let cube = integer(random, 0, 50_000);
  for (let i = 0; i < length; i++) {
    cube += integer(random, 40, 400);
    const recovered = random() < recoveredRate;
    const local = cube * skew + offset + integer(random, 0, 35);
    events.push({
      move: randomMove(random),
      serial: i & 0xff,
      cubeTimestamp: recovered ? null : cube,
      localTimestamp: recovered || (batched && random() < 0.5) ? null : Math.round(local),
    });
  }

  const timeline = new MoveTimeline(windowSize === undefined ? {} : { windowSize });
  const streamed = events.map((event) => {
    const timed = timeline.add(event);
    return { timestamp: timed.timestamp, source: timed.timestampSource };
  });
  return {
    kind: "timeline",
    windowSize: windowSize ?? null,
    events: events.map((event) => ({
      move: notation(event.move),
      serial: event.serial,
      cubeTimestamp: event.cubeTimestamp,
      localTimestamp: event.localTimestamp,
    })),
    streamed,
    skewPercent: timeline.skewPercent(),
    anchorCount: timeline.anchorCount,
    retimed: MoveTimeline.retime(events).map((timed) => ({
      timestamp: timed.timestamp,
      source: timed.timestampSource,
    })),
  };
}

/** Let every promise the tracker started settle before recording what it emitted. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function trackerCase(random: () => number) {
  // The cube's true state. The tracker only learns it through moves and `queryState`.
  let truth = applyMoves(CubeState.solved(), Array.from({ length: integer(random, 0, 20) }, () => randomMove(random)));
  const moveListeners = new Set<(event: MoveEvent) => void>();
  const source: CubeSource = {
    kind: "smart-cube",
    name: "test",
    onMove(listener) {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    onDisconnect: () => () => {},
    queryState: async () => truth.clone(),
    disconnect: async () => {},
  };

  const tracker = new CubeTracker(source, { verifyIntervalMs: 0 });
  const output: unknown[] = [];
  tracker.onMove((timed) =>
    output.push({ type: "move", move: notation(timed.move), serial: timed.serial, timestamp: timed.timestamp, source: timed.timestampSource }));
  tracker.onDesync((event) => output.push({ type: "desync", reason: event.reason, expected: event.expected, actual: event.actual }));
  tracker.onReseed((state) => output.push({ type: "reseed", facelets: toFacelets(state) }));

  const steps: unknown[] = [];
  const initial = toFacelets(truth);
  await tracker.start();
  await settle();
  steps.push({ op: "start", output: output.splice(0) });

  let serial = integer(random, 0, 255);
  let cube = integer(random, 0, 10_000);
  for (let i = 0, n = integer(random, 5, 60); i < n; i++) {
    const move = randomMove(random);
    truth = applyMoves(truth, [move]);
    cube += integer(random, 50, 300);
    // Sometimes the host misses a move entirely: the truth advances, the tracker never hears it.
    const missed = random() < 0.08;
    serial = (serial + 1) & 0xff;
    if (missed) {
      steps.push({ op: "missed", move: notation(move), output: [] });
      continue;
    }
    const event: MoveEvent = { move, serial, cubeTimestamp: cube, localTimestamp: cube + 5000 };
    for (const listener of [...moveListeners]) listener(event);
    await settle();
    steps.push({ op: "move", move: notation(move), serial, cubeTimestamp: cube, localTimestamp: cube + 5000, output: output.splice(0) });
  }
  await tracker.verify();
  await settle();
  steps.push({ op: "verify", truth: toFacelets(truth), output: output.splice(0) });
  await tracker.stop();
  return { kind: "tracker", initial, steps, final: toFacelets(tracker.getState()) };
}

// MARK: - the file

/**
 * @param count random messages per event type in each `decode` case.
 */
export async function cubeLinkVectors(seed: number, count: number): Promise<VectorFile> {
  const random = seeded(seed);
  const cases: unknown[] = [cryptoCase()];
  for (const generation of ["gen2", "gen3", "gen4"] as const) {
    cases.push({
      kind: "commands",
      generation,
      commands: COMMANDS.map((command) => ({
        command: command.type,
        hex: hex(driverFor(generation, () => 0).createCommandMessage(command)!),
      })),
    });
  }
  for (const generation of ["gen2", "gen3", "gen4"] as const) {
    cases.push(await decodeCase(generation, random, count));
  }
  cases.push(await captureCase());
  for (let i = 0; i < 6; i++) {
    cases.push(await recoveryCase(i % 2 === 0 ? "gen4" : "gen3", random, integer(random, 150, 400)));
  }
  cases.push(macCase(random));
  for (let i = 0; i < 60; i++) cases.push(timelineCase(random, i));
  for (let i = 0; i < 40; i++) cases.push(await trackerCase(random));
  // Eager recovery, what the apps use. Last, so adding it left every earlier case unchanged.
  for (let i = 0; i < 6; i++) {
    cases.push(await recoveryCase(i % 2 === 0 ? "gen4" : "gen3", random, integer(random, 150, 400), "eager"));
  }
  return { generator: "cubelink", seed, count, cases };
}
