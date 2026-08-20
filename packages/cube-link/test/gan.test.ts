/**
 * GAN adapter.
 *
 * The BLE transport itself needs hardware, but everything above it does not: move parsing,
 * the request/reply bridge for facelets, disconnect handling. A fake connection covers all
 * of it, which is what keeps the untestable surface down to the radio.
 */
import { describe, expect, it } from "vitest";
import { parseMoves, stateAfter, toFacelets } from "@cubing-companion/engine";
import {
  GanCubeSource,
  isWebBluetoothAvailable,
  parseGanMove,
  SmartCubeError,
  type GanEventLike,
} from "../src/gan.ts";
import type { MoveEvent } from "../src/source.ts";

/** Stands in for a `gan-web-bluetooth` connection. */
class FakeConnection {
  deviceName = "GAN-1234";
  commands: { type: string }[] = [];
  disconnected = false;
  private observers: ((event: GanEventLike) => void)[] = [];
  /** Facelets to answer the next REQUEST_FACELETS with. */
  facelets = toFacelets(stateAfter(parseMoves("")));

  events$ = {
    subscribe: (observer: (event: GanEventLike) => void) => {
      this.observers.push(observer);
      return {
        unsubscribe: () => {
          this.observers = this.observers.filter((o) => o !== observer);
        },
      };
    },
  };

  async sendCubeCommand(command: { type: string }): Promise<void> {
    this.commands.push(command);
    if (command.type === "REQUEST_FACELETS") {
      // The real protocol answers asynchronously, as an event.
      queueMicrotask(() =>
        this.emit({ type: "FACELETS", serial: 1, facelets: this.facelets }),
      );
    }
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  emit(event: GanEventLike): void {
    for (const observer of [...this.observers]) observer(event);
  }

  get subscriberCount(): number {
    return this.observers.length;
  }
}

const moveEvent = (
  move: string,
  serial: number,
  cubeTimestamp: number | null = 100,
  localTimestamp: number | null = 1000,
): GanEventLike => ({ type: "MOVE", serial, move, cubeTimestamp, localTimestamp });

describe("parsing moves from the cube", () => {
  it("handles every move the protocol can produce", () => {
    // Gen2 builds moves as `"URFDLB"[face] + " '"[direction]` — quarter turns only.
    for (const face of "URFDLB") {
      expect(parseGanMove(face)).toEqual({ family: face, amount: 1 });
      expect(parseGanMove(`${face}'`)).toEqual({ family: face, amount: -1 });
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseGanMove(" R ")).toEqual({ family: "R", amount: 1 });
  });

  it("refuses anything else rather than guessing", () => {
    // A protocol change should fail loudly, not silently apply a different turn.
    for (const bad of ["", "R2", "Rw", "x", "QQ", "R''"]) {
      expect(() => parseGanMove(bad), bad).toThrow(SmartCubeError);
    }
  });
});

describe("the adapter", () => {
  it("reports the device name", () => {
    const connection = new FakeConnection();
    expect(new GanCubeSource(connection).name).toBe("GAN-1234");
  });

  it("forwards moves with both clocks intact", () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));

    connection.emit(moveEvent("R", 5, 120, 1200));
    connection.emit(moveEvent("U'", 6, 340, null)); // batched: no host timestamp

    expect(moves).toHaveLength(2);
    expect(moves[0]).toEqual({
      move: { family: "R", amount: 1 },
      serial: 5,
      cubeTimestamp: 120,
      localTimestamp: 1200,
    });
    expect(moves[1]!.move).toEqual({ family: "U", amount: -1 });
    expect(moves[1]!.localTimestamp).toBeNull();
  });

  it("bridges the facelets request and its reply into a promise", async () => {
    const connection = new FakeConnection();
    connection.facelets = toFacelets(stateAfter(parseMoves("R U R'")));
    const source = new GanCubeSource(connection);

    const state = await source.queryState();
    expect(connection.commands).toEqual([{ type: "REQUEST_FACELETS" }]);
    expect(toFacelets(state)).toBe(connection.facelets);
  });

  it("answers concurrent state queries from one round trip", async () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    const [a, b] = await Promise.all([source.queryState(), source.queryState()]);
    expect(toFacelets(a)).toBe(toFacelets(b));
  });

  it("remembers the last reported state without a round trip", async () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    expect(source.lastKnownState()).toBeNull();

    connection.emit({
      type: "FACELETS",
      serial: 1,
      facelets: toFacelets(stateAfter(parseMoves("F"))),
    });
    expect(toFacelets(source.lastKnownState()!)).toBe(
      toFacelets(stateAfter(parseMoves("F"))),
    );
  });

  it("treats a DISCONNECT event as a disconnect", () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    let disconnects = 0;
    source.onDisconnect(() => disconnects++);

    connection.emit({ type: "DISCONNECT" });
    connection.emit({ type: "DISCONNECT" }); // must not fire twice
    expect(disconnects).toBe(1);
  });

  it("unsubscribes from the radio when disconnected", async () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    expect(connection.subscriberCount).toBe(1);

    await source.disconnect();
    expect(connection.subscriberCount).toBe(0);
    expect(connection.disconnected).toBe(true);
  });

  it("refuses to query a disconnected cube", async () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    await source.disconnect();
    await expect(source.queryState()).rejects.toThrow(SmartCubeError);
  });

  it("ignores events it does not use", () => {
    const connection = new FakeConnection();
    const source = new GanCubeSource(connection);
    const moves: MoveEvent[] = [];
    source.onMove((m) => moves.push(m));

    connection.emit({ type: "GYRO", quaternion: { x: 0, y: 0, z: 0, w: 1 } });
    connection.emit({ type: "BATTERY", batteryLevel: 80 });
    connection.emit({ type: "HARDWARE", hardwareName: "GAN356i" });
    expect(moves).toEqual([]);
  });
});

describe("browser capability", () => {
  it("detects the absence of Web Bluetooth", () => {
    // Node has no navigator.bluetooth, which is the same answer Safari gives.
    expect(isWebBluetoothAvailable()).toBe(false);
  });
});
