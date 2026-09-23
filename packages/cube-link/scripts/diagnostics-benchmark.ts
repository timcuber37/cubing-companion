/** Synthetic CPU/storage baseline only; this does not measure Bluetooth or hardware. */
import { GanDiagnosticRecorder, diagnosticDistribution } from "../src/diagnostics.ts";
import type { GanDiagnosticPacket } from "../src/gan.ts";

const packets: GanDiagnosticPacket[] = Array.from({ length: 12_000 }, (_, i) => {
  const receivedAt = 1000 + i * 10;
  const halfAngle = i * Math.PI / 360;
  return { receivedAt, event: i % 20 === 0
    ? { type: "MOVE", move: "R", serial: (i / 20) % 256, cubeTimestamp: i * 10, localTimestamp: receivedAt - 1 }
    : { type: "GYRO", timestamp: receivedAt - 1,
      quaternion: { x: Math.sin(halfAngle), y: 0, z: 0, w: Math.cos(halfAngle) } } };
});

function run(record: boolean) {
  let clock = 1000;
  const recorder = new GanDiagnosticRecorder({ now: () => clock });
  recorder.connect({ libraryVersion: "synthetic", protocol: "unknown", serviceUuid: null, stateCharacteristicUuid: null }, null, null);
  if (record) recorder.start({ notes: "Synthetic benchmark; not hardware evidence" });
  const receiveMs: number[] = [];
  for (const packet of packets) {
    clock = packet.receivedAt;
    const before = performance.now();
    recorder.receive(packet);
    receiveMs.push(performance.now() - before);
  }
  const summaryMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    recorder.summary();
    summaryMs.push(performance.now() - before);
  }
  return {
    receiveMs: diagnosticDistribution(receiveMs), summaryMs: diagnosticDistribution(summaryMs),
    exportBytes: record ? Buffer.byteLength(JSON.stringify(recorder.export())) : 0,
  };
}

run(false); run(true); // warm JIT before the reported pass
process.stdout.write(JSON.stringify({
  scenario: "12,000 synthetic packets at 100 Hz, 95% gyro / 5% moves; warm Node process",
  node: process.version, platform: `${process.platform}/${process.arch}`,
  disabled: run(false), recording: run(true),
  limitations: "CPU costs and JSON bytes only. Browser, BLE, sensor delay, and full UI work require real measurements.",
}, null, 2) + "\n");
