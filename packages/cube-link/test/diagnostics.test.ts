import { describe, expect, it } from "vitest";
import { GanDiagnosticRecorder, diagnosticDistribution } from "../src/diagnostics.ts";
import type { GanEventLike, GanTransportInfo } from "../src/gan.ts";

const transport: GanTransportInfo = { libraryVersion: "3.0.2", protocol: "gen4",
  serviceUuid: "00000010-0000-fff7-fff6-fff5fff4fff0", stateCharacteristicUuid: null };
const hardware = { hardwareName: "test i4", softwareVersion: "test", hardwareVersion: null, gyroSupported: false };
const identity = { x: 0, y: 0, z: 0, w: 1 };

function setup(options: { maxEvents?: number; maxDurationMs?: number } = {}) {
  let clock = 1_000;
  const recorder = new GanDiagnosticRecorder({ now: () => clock, wallNow: () => 0, ...options });
  recorder.connect(transport, hardware, null);
  const send = (at: number, event: GanEventLike) => {
    clock = at;
    recorder.receive({ event, receivedAt: at });
  };
  return { recorder, send, tick: (at: number) => { clock = at; },
    gyro: (at: number, quaternion = identity) => send(at, { type: "GYRO", timestamp: at - 1, quaternion }) };
}

describe("Phase 0 diagnostics", () => {
  it("is opt-in and cannot start disconnected", () => {
    const { recorder, gyro } = setup();
    gyro(1100);
    expect(recorder.summary().gyroSamples).toBe(0);
    expect(() => recorder.export()).toThrow("Record diagnostics");
    recorder.disconnect();
    expect(() => recorder.start()).toThrow("Connect a smart cube");
  });

  it("captures even when the advertised support is false and preserves both host times", () => {
    const { recorder, gyro } = setup();
    recorder.start();
    gyro(1100); gyro(1200); gyro(1300);
    const summary = recorder.summary();
    expect(summary).toMatchObject({ gyroSamples: 3, invalidQuaternions: 0, observedHz: 10,
      reportedSupport: false, validInCurrentEpoch: 3, stream: "receiving" });
    const capture = recorder.export();
    expect(capture.events[1]).toMatchObject({ type: "GYRO", atMs: 100, data: { eventTimestampMs: 99, quaternion: identity } });
    expect(capture.events[0]!.type).toBe("CONNECT");
    expect(capture.mode).toEqual({ value: "unknown", source: "user-reported" });
  });

  it("records malformed quaternions as explicit, JSON-safe evidence", () => {
    const { recorder, send, gyro } = setup();
    recorder.start();
    send(1100, { type: "GYRO", quaternion: { x: NaN, y: 0, z: 0, w: Infinity } });
    gyro(1200, { x: 0, y: 0, z: 0, w: 0 });
    send(1300, { type: "GYRO", quaternion: "bad", deviceMAC: "SECRET" });
    gyro(1400, { x: 2, y: 0, z: 0, w: 0 });
    const capture = recorder.export();
    expect(capture.summary).toMatchObject({ gyroSamples: 4, invalidQuaternions: 4,
      invalidGyroTimestamps: 2, stream: "invalid", validInCurrentEpoch: 0 });
    expect(capture.events[1]!.data.quaternion).toEqual({ x: null, y: 0, z: 0, w: null });
    expect(capture.events[2]!.data.issue).toBe("zero-norm");
    expect(capture.events[4]!.data.issue).toBe("non-unit-norm");
    expect(JSON.stringify(capture)).not.toContain("SECRET");
  });

  it("uses sign-invariant relative angles, resetting the reference at a marker", () => {
    const { recorder, gyro } = setup();
    recorder.start();
    recorder.mark("still");
    gyro(1100);
    gyro(1200, { x: 0, y: 0, z: 0, w: -1 });
    expect(recorder.summary().maxAngleFromMarkerDegrees).toBe(0);
    const quarter = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    gyro(1300, quarter);
    expect(recorder.summary().angleFromMarkerDegrees).toBeCloseTo(90);
    recorder.mark("new hold");
    expect(recorder.summary().angleFromMarkerDegrees).toBeNull();
    gyro(1400, quarter);
    expect(recorder.summary().angleFromMarkerDegrees).toBeCloseTo(0);
  });

  it("marks stale streams including a trailing gap and does not infer missing packets", () => {
    const { recorder, gyro, tick } = setup();
    recorder.start();
    tick(2000);
    expect(recorder.summary()).toMatchObject({ stream: "waiting", observedHz: null, latestGyroAgeMs: null });
    gyro(2100); gyro(2200);
    tick(3000);
    expect(recorder.summary()).toMatchObject({ stream: "stale", gapsOver500Ms: 1, latestGyroAgeMs: 800 });
    gyro(3100);
    expect(recorder.summary()).toMatchObject({ stream: "receiving", gapsOver500Ms: 1 });
    expect(recorder.export().summary.intervalsMs.max).toBe(900);
  });

  it("keeps reconnects in separate epochs and freezes a stopped summary", () => {
    const { recorder, gyro, tick } = setup();
    recorder.start();
    gyro(1100); gyro(1200);
    recorder.disconnect();
    tick(9000);
    expect(recorder.summary().stream).toBe("disconnected");
    recorder.connect(transport, hardware, null);
    expect(recorder.summary()).toMatchObject({ stream: "waiting", validInCurrentEpoch: 0 });
    gyro(9100); gyro(9200);
    expect(recorder.summary().intervalsMs).toEqual({ count: 2, p50: 100, p95: 100, max: 100 });
    recorder.stop();
    const before = recorder.export();
    tick(20000);
    recorder.disconnect();
    recorder.connect(transport, hardware, null);
    gyro(21000);
    expect(recorder.export()).toEqual(before);
    expect(before.events.filter((e) => e.type === "CONNECT").map((e) => e.epoch)).toEqual([1, 2]);
    expect(before.events.filter((e) => e.type === "DISCONNECT")).toHaveLength(1);
  });

  it("bounds capture by events and by elapsed time even with no incoming gyro", () => {
    const short = setup({ maxEvents: 3 });
    short.recorder.start();
    short.gyro(1100); short.gyro(1200); short.gyro(1300);
    expect(short.recorder.summary()).toMatchObject({ state: "stopped", stopReason: "event-limit", events: 3, gyroSamples: 2 });
    const timed = setup({ maxDurationMs: 1000 });
    timed.recorder.start();
    timed.tick(5000);
    expect(timed.recorder.summary()).toMatchObject({ state: "stopped", stopReason: "duration-limit", durationMs: 1000 });
    timed.gyro(5100);
    expect(timed.recorder.export().events).toHaveLength(1);
  });

  it("keeps batched move clocks distinct and labels host dispatch separately", () => {
    const { recorder, send } = setup();
    recorder.start();
    send(1100, { type: "MOVE", timestamp: 1099, move: "R", serial: 255, cubeTimestamp: 123, localTimestamp: 1098 });
    send(1100, { type: "MOVE", timestamp: 1099, move: "U'", serial: 0, cubeTimestamp: 130, localTimestamp: null });
    const capture = recorder.export();
    expect(capture.summary).toMatchObject({ moves: 2, hostDispatchMs: { count: 1, p50: 2 } });
    expect(capture.events[1]!.data).toMatchObject({ cubeTimestamp: 123, localTimestampMs: 98, eventTimestampMs: 99 });
    expect(capture.events[2]!.data.localTimestampMs).toBeNull();
  });

  it("retains hardware updates, visibility and timings without exporting unrelated fields", () => {
    const { recorder, send } = setup();
    recorder.start({ mode: "performance", notes: "test", browser: "test browser" });
    send(1100, { type: "HARDWARE", hardwareName: "i4", softwareVersion: "v2", gyroSupported: true, key: "SECRET" });
    send(1200, { type: "FACELETS", serial: 0, facelets: "U".repeat(54), mac: "SECRET" });
    recorder.visibility("hidden");
    recorder.timing("planner", 240);
    recorder.timing("move-handler", 2);
    recorder.timing("planner", NaN);
    const capture = recorder.export();
    expect(capture.summary.reportedSupport).toBe(true);
    expect(capture.summary.plannerMs).toMatchObject({ count: 1, p50: 240 });
    expect(capture.summary.moveHandlingMs).toMatchObject({ count: 1, p50: 2 });
    expect(capture.events.map((e) => e.type)).toContain("VISIBILITY");
    expect(JSON.stringify(capture)).not.toContain("SECRET");
    (capture.events as unknown[]).pop();
    expect(recorder.export().events.length).toBe(capture.events.length + 1);
  });

  it("does not calculate a rate from duplicate or reversed arrival times", () => {
    const { recorder, gyro } = setup();
    recorder.start();
    gyro(1200); gyro(1200); gyro(1100);
    expect(recorder.summary()).toMatchObject({ nonIncreasingArrivalTimes: 2, observedHz: null });
  });

  it("starts a clean next recording with the latest hardware metadata", () => {
    const { recorder, gyro, send } = setup();
    recorder.start();
    gyro(1100);
    expect(() => recorder.start()).toThrow("Stop the current");
    recorder.stop();
    send(1200, { type: "HARDWARE", hardwareName: "updated", gyroSupported: true });
    recorder.start();
    expect(recorder.summary()).toMatchObject({ gyroSamples: 0, events: 1, reportedSupport: true });
    expect(recorder.export().events[0]!.data.hardware).toMatchObject({ hardwareName: "updated" });
  });

  it("computes percentiles without assuming a fixed sample rate", () => {
    expect(diagnosticDistribution([100, 50, 1000, 200])).toEqual({ count: 4, p50: 100, p95: 1000, max: 1000 });
    expect(diagnosticDistribution([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  });
});
