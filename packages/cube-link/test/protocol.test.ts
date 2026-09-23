/**
 * The vendored protocol against the one it was vendored from.
 *
 * `gan-web-bluetooth` is the reference implementation, and the point of this file is that it stays
 * the reference: every decoded event, every command message and every disconnect the vendored
 * drivers produce is compared against what the library produces from the same bytes. If the two
 * ever disagree, this fails and names the message.
 *
 * Two sources of bytes, covering different things:
 *
 * - **The committed capture** — 1,213 frames from a real GAN i Carry 4, decrypted and decoded here.
 *   Proves the whole Gen4 stack against hardware, but only over the messages that happened to occur.
 * - **Generated messages** — random payloads under each known event type, for all three
 *   generations. Covers the decode paths a two-minute solve never reaches, including Gen2 and Gen3,
 *   which nobody here owns a cube for.
 *
 * The library is a devDependency for exactly this. It is no longer in the shipping path — nothing
 * under `src/` imports it — but keeping it here means the comparison stays live rather than
 * decaying into a golden file that nobody can regenerate.
 *
 * Clocks are made deterministic by pinning `process.hrtime.bigint`, which is what the reference's
 * `now()` reads in Node. Both sides then stamp identical timestamps and the events compare exactly.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import capture from "./fixtures/gan-gen4-frames.json" with { type: "json" };
import { GanGen2Driver } from "../src/gan/gen2.ts";
import { GanGen3Driver } from "../src/gan/gen3.ts";
import { GanGen4Driver } from "../src/gan/gen4.ts";
import { encrypterFor } from "../src/gan/crypto.ts";
import { GanMessageView } from "../src/gan/message.ts";
import { isCube } from "../src/gan/facelets.ts";
import { framesToBytes, type ProtocolCapture } from "../src/ble/capture.ts";
import type { GanCubeCommand, GanDriverConnection } from "../src/gan/events.ts";

const fixture = capture as ProtocolCapture;

/**
 * The reference implementation, loaded at runtime rather than imported.
 *
 * Its drivers are not in the package's export map, so this reaches for the source file directly.
 * A static import would pull that file into our `tsc` program, where it does not compile — it
 * wants DOM types we deliberately do not have and `@types/aes-js` we deliberately do not install.
 * A computed specifier keeps it out of the type graph while vitest still resolves it.
 */
const REFERENCE = new URL(
  "../../../node_modules/gan-web-bluetooth/src/gan-cube-protocol.ts",
  import.meta.url,
).href;

interface ReferenceDriver {
  handleStateEvent(connection: unknown, message: Uint8Array): Promise<unknown[]>;
  createCommandMessage(command: unknown): Uint8Array | undefined;
}
type DriverClass = new () => ReferenceDriver;
let Reference: Record<string, DriverClass>;

beforeAll(async () => {
  Reference = (await import(/* @vite-ignore */ REFERENCE)) as Record<string, DriverClass>;
});

/** Pinned clock, shared by both implementations so timestamps are comparable. */
let nanos = 0n;
const realHrtime = process.hrtime.bigint;
const clock = () => Number(nanos / 1_000_000n);
const tick = (ms: number) => {
  nanos += BigInt(ms) * 1_000_000n;
};

beforeEach(() => {
  nanos = 0n;
  process.hrtime.bigint = () => nanos;
});
afterEach(() => {
  process.hrtime.bigint = realHrtime;
});

/** Records what a driver tried to send, so command layouts are compared too. */
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
  return { connection, sent, get disconnects() { return disconnects; } };
}

interface FaceletsLike {
  type: "FACELETS";
  state: { CP: number[]; CO: number[]; EP: number[]; EO: number[] };
}
const isFacelets = (event: unknown): event is FaceletsLike =>
  (event as { type?: string }).type === "FACELETS";
const hasFacelets = (events: readonly unknown[]) => events.some(isFacelets);

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Deterministic PRNG, so a failure is reproducible from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generation {
  readonly name: string;
  readonly size: number;
  readonly reference: () => ReferenceDriver;
  readonly vendored: () => {
    handleStateEvent(connection: GanDriverConnection, message: Uint8Array): Promise<unknown[]>;
    createCommandMessage(command: GanCubeCommand): Uint8Array | undefined;
  };
  /** Writes a message of the given event type, with the rest random. */
  readonly compose: (type: number, payload: Uint8Array) => Uint8Array;
  readonly eventTypes: readonly number[];
}

const GENERATIONS: readonly Generation[] = [
  {
    name: "Gen2",
    size: 20,
    reference: () => new Reference.GanGen2ProtocolDriver!(),
    vendored: () => new GanGen2Driver(clock),
    // Event type is the top nibble of byte 0.
    compose: (type, payload) => {
      const message = new Uint8Array(payload);
      message[0] = ((type & 0x0f) << 4) | (message[0]! & 0x0f);
      return message;
    },
    eventTypes: [0x01, 0x02, 0x04, 0x05, 0x09, 0x0d],
  },
  {
    name: "Gen3",
    size: 16,
    reference: () => new Reference.GanGen3ProtocolDriver!(),
    vendored: () => new GanGen3Driver(clock),
    compose: (type, payload) => {
      const message = new Uint8Array(payload);
      message[0] = 0x55; // magic
      message[1] = type;
      message[2] = Math.max(1, message[2]! & 0x07); // data length, must be non-zero
      return message;
    },
    eventTypes: [0x01, 0x02, 0x06, 0x07, 0x10, 0x11],
  },
  {
    name: "Gen4",
    size: 20,
    reference: () => new Reference.GanGen4ProtocolDriver!(),
    vendored: () => new GanGen4Driver(clock),
    compose: (type, payload) => {
      const message = new Uint8Array(payload);
      message[0] = type;
      message[1] = Math.max(1, message[1]! & 0x07);
      return message;
    },
    eventTypes: [0x01, 0xd1, 0xed, 0xfa, 0xfc, 0xfd, 0xfe, 0xec, 0xef, 0xea],
  },
];

const COMMANDS: readonly GanCubeCommand[] = [
  { type: "REQUEST_FACELETS" },
  { type: "REQUEST_HARDWARE" },
  { type: "REQUEST_BATTERY" },
  { type: "REQUEST_RESET" },
];

describe.each(GENERATIONS)("$name driver", (generation) => {
  it("builds identical command messages", () => {
    const reference = generation.reference();
    const vendored = generation.vendored();
    for (const command of COMMANDS) {
      const a = reference.createCommandMessage(command);
      const b = vendored.createCommandMessage(command);
      expect(b, command.type).toBeDefined();
      expect(hex(b!), command.type).toBe(hex(a!));
    }
  });

  it("decodes generated messages identically, event for event", async () => {
    const next = random(0x5eed);
    const reference = generation.reference();
    const vendored = generation.vendored();
    const referenceIo = recorder();
    const vendoredIo = recorder();

    // Messages the reference cannot survive — see the note below. Counted so the divergence stays
    // deliberate: if this ever drops to zero, the hardening has stopped being exercised.
    let referenceCrashes = 0;
    /** Messages where the reference reported a state that is not a cube. */
    let referenceInvalid = 0;

    // 200 messages per event type is enough to exercise every branch inside each decoder,
    // including the serial arithmetic that only triggers on particular values.
    for (const type of generation.eventTypes) {
      for (let i = 0; i < 200; i++) {
        const payload = new Uint8Array(generation.size);
        for (let b = 0; b < payload.length; b++) payload[b] = Math.floor(next() * 256);
        const message = generation.compose(type, payload);
        const where = `${generation.name} type 0x${type.toString(16)} #${i}: ${hex(message)}`;

        tick(1 + Math.floor(next() * 40));

        let expected: unknown[] | null = null;
        try {
          expected = await reference.handleStateEvent(referenceIo.connection, message);
        } catch {
          // The reference indexes its facelet maps with whatever arrived, so a payload that is
          // not a valid permutation throws a TypeError out of the notification handler. Over BLE
          // that is a mangled packet ending the session. The vendored decoder validates instead.
          referenceCrashes++;
        }

        // Whatever the bytes were, ours must not throw.
        const actual = await vendored.handleStateEvent(vendoredIo.connection, message);

        if (expected === null) {
          expect(hasFacelets(actual), where).toBe(false);
          continue;
        }

        // The other half of the same problem, and the worse half: when the bad indices happen to
        // land in range, the reference does not crash — it reports a cube that cannot exist, with
        // duplicate edges and NaN orientations. Silently feeding that downstream would desync the
        // tracker against a state no cube was ever in. We emit nothing instead.
        const bogus = expected.find(
          (event) => isFacelets(event) && !isCube(event.state.CP, event.state.CO, event.state.EP, event.state.EO),
        );
        if (bogus) {
          referenceInvalid++;
          expect(hasFacelets(actual), where).toBe(false);
          expect(actual, where).toEqual(expected.filter((event) => !isFacelets(event)));
          continue;
        }

        expect(actual, where).toEqual(expected);
      }
    }

    // Both hardening paths must stay exercised, or this test has quietly stopped proving anything.
    expect(referenceCrashes + referenceInvalid, "the malformed-state paths are no longer covered")
      .toBeGreaterThan(0);

    // Commands the drivers decided to send on their own — move-history requests, mostly.
    expect(vendoredIo.sent).toEqual(referenceIo.sent);
    expect(vendoredIo.disconnects).toBe(referenceIo.disconnects);
  });
});

describe("Gen4 against the recorded cube", () => {
  it("decodes all 1,213 real frames identically", async () => {
    const encrypter = encrypterFor(fixture.deviceName, fixture.mac);
    const frames = framesToBytes(fixture).map((frame) => encrypter.decrypt(frame));

    const reference = new Reference.GanGen4ProtocolDriver!();
    const vendored = new GanGen4Driver(clock);
    const referenceIo = recorder();
    const vendoredIo = recorder();

    const released = new Map<string, number>();
    for (const [i, frame] of frames.entries()) {
      // Advance the clock the way the capture says the frames actually arrived.
      nanos = BigInt(Math.round(fixture.frames[i]!.atMs * 1_000_000));
      const expected = await reference.handleStateEvent(referenceIo.connection, frame);
      const actual = await vendored.handleStateEvent(vendoredIo.connection, frame);
      expect(actual, `frame ${i}: ${hex(frame)}`).toEqual(expected);
      for (const event of actual as { type: string }[]) {
        released.set(event.type, (released.get(event.type) ?? 0) + 1);
      }
    }

    // Move-history requests, byte for byte. The capture has 21 serial gaps, so these fire.
    expect(vendoredIo.sent).toEqual(referenceIo.sent);
    expect(vendoredIo.sent.length).toBeGreaterThan(0);

    // Sanity: equality above would also hold if both sides decoded nothing at all.
    //
    // Facelet reports are released immediately, so all 138 come out. Moves do not: they are held
    // until contiguous, and this replay answers none of the history requests it makes — a live
    // cube would. So a minority of the 1,063 moves are released here, and that is the honest
    // number rather than a bug. Both implementations agree on which, which is the point.
    expect(released.get("FACELETS")).toBe(138);
    expect(released.get("MOVE")).toBeGreaterThan(100);
  });

  it("decrypts to the message types the capture was validated against", () => {
    // The numbers recorded in MOBILE_PLAN.md when the fixture was committed.
    const encrypter = encrypterFor(fixture.deviceName, fixture.mac);
    const counts = new Map<number, number>();
    for (const frame of framesToBytes(fixture)) {
      const type = new GanMessageView(encrypter.decrypt(frame)).word(0, 8);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    expect(counts.get(0x01)).toBe(1063); // MOVE
    expect(counts.get(0xed)).toBe(138); // FACELETS
    expect(counts.get(0xef)).toBe(11); // BATTERY
  });
});

describe("the bit reader", () => {
  it("agrees with the reference's string-slicing implementation", () => {
    // The vendored reader is arithmetic rather than string-based, which is the one place the
    // implementation deliberately diverges. Same answers, no allocation.
    const referenceRead = (bytes: Uint8Array, start: number, length: number, le = false) => {
      const bits = [...bytes].map((byte) => (byte + 0x100).toString(2).slice(1)).join("");
      if (length <= 8) return Number.parseInt(bits.slice(start, start + length), 2);
      const buffer = new Uint8Array(length / 8);
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Number.parseInt(bits.slice(8 * i + start, 8 * i + start + 8), 2);
      }
      const dv = new DataView(buffer.buffer);
      return length === 16 ? dv.getUint16(0, le) : dv.getUint32(0, le);
    };

    const next = random(0xb175);
    for (let trial = 0; trial < 500; trial++) {
      const bytes = new Uint8Array(20);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
      const view = new GanMessageView(bytes);

      for (const length of [1, 2, 3, 4, 6, 8]) {
        const start = Math.floor(next() * (160 - length));
        expect(view.word(start, length)).toBe(referenceRead(bytes, start, length));
      }
      for (const length of [16, 32]) {
        const start = Math.floor(next() * (160 - length));
        for (const le of [false, true]) {
          expect(view.word(start, length, le)).toBe(referenceRead(bytes, start, length, le));
        }
      }
    }
  });

  it("rejects widths the protocol never uses", () => {
    expect(() => new GanMessageView(new Uint8Array(20)).word(0, 24)).toThrow(/unsupported/);
  });
});
