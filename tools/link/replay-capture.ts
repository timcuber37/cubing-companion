/**
 * Decode a recorded cube session and show where its moves were held.
 *
 * Run: npm run link-replay -- path/to/gan-gen4-capture-….json [log]
 *
 * Reads a capture in the fixture format — what the native app's "Record frames" shares, including
 * its `writes` — decrypts every frame in and command out, and replays the frames through the Gen4
 * driver at the times they arrived. Prints the loss and hold statistics; with `log`, the whole
 * timeline, one line per frame, with what the driver released after each.
 *
 * The replay uses the reference recovery strategy and does not answer anything, because a recording
 * is not a live cube: its history answers belong to the requests that were really sent. It shows
 * what happened, not what another strategy would have done — `npm run link-sim` is for that.
 */
import { readFileSync } from "node:fs";
import { encrypterFor } from "../../packages/cube-link/src/gan/crypto.ts";
import { GanGen4Driver } from "../../packages/cube-link/src/gan/gen4.ts";
import type { GanDriverConnection, GanMoveEvent } from "../../packages/cube-link/src/gan/events.ts";

interface Recording {
  deviceName: string | null;
  mac: string;
  protocol: string;
  frames: { atMs: number; hex: string }[];
  writes?: { atMs: number; hex: string }[];
}

const [file, mode] = process.argv.slice(2);
if (!file) throw new Error("usage: npm run link-replay -- <capture.json> [log]");
const capture = JSON.parse(readFileSync(file, "utf8")) as Recording;
if (capture.protocol !== "gen4") throw new Error(`only Gen4 recordings are decoded, not ${capture.protocol}`);

const encrypter = encrypterFor(capture.deviceName, capture.mac);
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const LIVE = [2, 32, 8, 1, 16, 4];
const HISTORY = [1, 5, 3, 0, 4, 2];
const FACES = "URFDLB";

interface Item {
  readonly at: number;
  readonly incoming: boolean;
  readonly plain: Uint8Array;
}
const items: Item[] = [
  ...capture.frames.map((f) => ({ at: f.atMs, incoming: true, plain: encrypter.decrypt(bytes(f.hex)) })),
  ...(capture.writes ?? []).map((w) => ({ at: w.atMs, incoming: false, plain: encrypter.decrypt(bytes(w.hex)) })),
].sort((a, b) => a.at - b.at);

function describe({ incoming, plain: p }: Item): string {
  if (!incoming) {
    return p[0] === 0xd1 ? `ask history from #${p[2]} for ${p[4]}` : `command ${p[0]!.toString(16)}`;
  }
  switch (p[0]) {
    case 0x01: {
      const face = LIVE.indexOf(p[8]! & 0x3f);
      const cube = p[2]! + p[3]! * 2 ** 8 + p[4]! * 2 ** 16 + p[5]! * 2 ** 24;
      return `move #${p[6]! | (p[7]! << 8)} ${FACES[face] ?? "?"}${p[8]! >> 6 === 1 ? "'" : ""} cube ${cube}`;
    }
    case 0xd1: {
      const moves = [];
      for (let k = 0; k < (p[1]! - 1) * 2; k++) {
        const nibble = (p[3 + (k >> 1)]! >> (k % 2 === 0 ? 4 : 0)) & 0xf;
        const face = HISTORY.indexOf(nibble >> 1);
        moves.push(`#${(p[2]! - k) & 0xff}${face >= 0 ? FACES[face] + (nibble & 1 ? "'" : "") : "·"}`);
      }
      return `history [${moves.join(" ")}]`;
    }
    case 0xed:
      return `facelets #${p[2]! | (p[3]! << 8)}`;
    case 0xef:
      return "battery";
    default:
      return `type 0x${p[0]!.toString(16)}`;
  }
}

let clock = 0;
const driver = new GanGen4Driver(() => clock);
const connection: GanDriverConnection = { sendCommandMessage: async () => {}, disconnect: async () => {} };
const arrived = new Map<number, number>();
const holds: { serial: number; held: number | null }[] = [];
for (const item of items) {
  let note = "";
  if (item.incoming) {
    clock = item.at;
    if (item.plain[0] === 0x01) arrived.set(item.plain[6]!, item.at);
    const moves = (await driver.handleStateEvent(connection, item.plain))
      .filter((e): e is GanMoveEvent => e.type === "MOVE");
    for (const move of moves) {
      holds.push({ serial: move.serial, held: move.localTimestamp === null ? null : item.at - arrived.get(move.serial)! });
    }
    if (moves.length > 0) {
      note = `  → released ${moves.map((m) => `#${m.serial}${m.localTimestamp === null ? " (recovered)" : ""}`).join(" ")}`;
    }
  }
  if (mode === "log") {
    console.log(`${item.at.toFixed(1).padStart(9)} ${item.incoming ? "←" : "→"} ${describe(item)}${note}`);
  }
}

const held = holds.flatMap((h) => (h.held !== null && h.held > 5 ? [h.held] : [])).sort((a, b) => b - a);
const count = (incoming: boolean, type: number) =>
  items.filter((i) => i.incoming === incoming && i.plain[0] === type).length;
console.log(`${file.split("/").pop()}`);
console.log(`  moves: ${arrived.size} arrived live, ${holds.length} released, ${holds.filter((h) => h.held === null).length} recovered from history`);
console.log(`  history: ${count(false, 0xd1)} asked, ${count(true, 0xd1)} answers`);
console.log(`  held over 5 ms: ${held.length}; longest ${held.slice(0, 8).map(Math.round).join(", ")} ms`);
