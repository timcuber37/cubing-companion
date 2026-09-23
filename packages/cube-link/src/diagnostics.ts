/** Bounded, opt-in Phase 0 capture. Nothing here interprets gyro motion as cube moves. */
import type { GanDiagnosticPacket, GanHardwareInfo, GanTransportInfo } from "./gan.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DiagnosticMode = "unknown" | "performance" | "endurance";
export type DiagnosticStopReason = "manual" | "duration-limit" | "event-limit";
export interface DiagnosticEvent {
  readonly ordinal: number;
  readonly epoch: number;
  readonly atMs: number;
  readonly type: "CONNECT" | "DISCONNECT" | "GYRO" | "MOVE" | "FACELETS" | "HARDWARE" | "MARKER" | "VISIBILITY" | "TIMING";
  readonly data: { readonly [key: string]: Json };
}

export interface DiagnosticDistribution {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export function diagnosticDistribution(values: readonly number[]): DiagnosticDistribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown, limit = 160): string | null =>
  typeof value === "string" ? value.slice(0, limit) : null;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
function hardwareInfo(value: unknown): GanHardwareInfo {
  const info = object(value);
  return {
    hardwareName: text(info.hardwareName), hardwareVersion: text(info.hardwareVersion),
    softwareVersion: text(info.softwareVersion),
    gyroSupported: typeof info.gyroSupported === "boolean" ? info.gyroSupported : null,
  };
}

interface Connection {
  transport: GanTransportInfo;
  hardware: GanHardwareInfo;
  facelets: string | null;
}

export interface DiagnosticSummary {
  readonly state: "idle" | "recording" | "stopped";
  readonly stopReason: DiagnosticStopReason | null;
  readonly durationMs: number;
  readonly events: number;
  readonly moves: number;
  readonly gyroSamples: number;
  readonly invalidQuaternions: number;
  readonly invalidGyroTimestamps: number;
  readonly nonIncreasingArrivalTimes: number;
  readonly intervalsMs: DiagnosticDistribution;
  readonly observedHz: number | null;
  readonly gapsOver500Ms: number;
  readonly latestGyroAgeMs: number | null;
  readonly stream: "disconnected" | "waiting" | "receiving" | "stale" | "invalid";
  readonly reportedSupport: boolean | null;
  readonly validInCurrentEpoch: number;
  readonly quaternion: readonly (number | null)[] | null;
  /** A diagnostic relative angle, not calibrated yaw or a rotation count. */
  readonly angleFromMarkerDegrees: number | null;
  readonly maxAngleFromMarkerDegrees: number | null;
  readonly marker: string | null;
  readonly hostDispatchMs: DiagnosticDistribution;
  readonly moveHandlingMs: DiagnosticDistribution;
  readonly plannerMs: DiagnosticDistribution;
}

export interface DiagnosticCapture {
  readonly format: "cubing-companion.gyro-diagnostic";
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly mode: { readonly value: DiagnosticMode; readonly source: "user-reported" };
  readonly notes: string;
  readonly browser: string;
  readonly clock: "host performance.now, milliseconds relative to capture start";
  readonly limits: { readonly maxEvents: number; readonly maxDurationMs: number };
  readonly summary: DiagnosticSummary;
  readonly events: readonly DiagnosticEvent[];
}

/** Injectable clocks and limits make gaps, stopping, reconnects, and exports reproducible. */
export class GanDiagnosticRecorder {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  readonly maxEvents: number;
  readonly maxDurationMs: number;
  private connection: Connection | null = null;
  private state: DiagnosticSummary["state"] = "idle";
  private reason: DiagnosticStopReason | null = null;
  private origin = 0;
  private startedAt = "";
  private stoppedAt = 0;
  private epoch = 0;
  private events: DiagnosticEvent[] = [];
  private mode: DiagnosticMode = "unknown";
  private notes = "";
  private browser = "";
  private intervals: number[] = [];
  private dispatch: number[] = [];
  private moveHandling: number[] = [];
  private planner: number[] = [];
  private gyro = 0;
  private moves = 0;
  private invalid = 0;
  private invalidTimes = 0;
  private nonIncreasing = 0;
  private validInEpoch = 0;
  private lastGyroAt: number | null = null;
  private lastQuaternion: (number | null)[] | null = null;
  private reference: number[] | null = null;
  private angle: number | null = null;
  private maxAngle: number | null = null;
  private marker: string | null = null;
  private finalSummary: DiagnosticSummary | null = null;

  constructor(options: { now?: () => number; wallNow?: () => number; maxEvents?: number; maxDurationMs?: number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.maxEvents = options.maxEvents ?? 30_000;
    this.maxDurationMs = options.maxDurationMs ?? 600_000;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 2 ||
        !Number.isFinite(this.maxDurationMs) || this.maxDurationMs <= 0) {
      throw new RangeError("Diagnostic limits must be positive; maxEvents must be an integer >= 2");
    }
  }

  connect(transport: GanTransportInfo, hardware: GanHardwareInfo | null, facelets: string | null): void {
    this.disconnect();
    this.connection = {
      // Deliberate allowlist: no device name/address, connection object, or encryption keys.
      transport: { libraryVersion: transport.libraryVersion, serviceUuid: transport.serviceUuid,
        stateCharacteristicUuid: transport.stateCharacteristicUuid, protocol: transport.protocol },
      hardware: hardwareInfo(hardware), facelets: text(facelets, 54),
    };
    this.resetEpoch();
    if (this.state === "recording") this.recordConnection();
  }

  disconnect(): void {
    if (this.connection === null) return;
    this.append("DISCONNECT", {});
    this.connection = null;
    this.resetEpoch();
  }

  private resetEpoch(): void {
    this.lastGyroAt = null;
    this.validInEpoch = 0;
    this.lastQuaternion = null;
    this.reference = null;
    this.angle = this.maxAngle = null;
  }

  private recordConnection(): void {
    if (!this.connection) return;
    this.epoch++;
    this.append("CONNECT", { transport: { ...this.connection.transport },
      hardware: { ...this.connection.hardware }, lastReportedFacelets: this.connection.facelets });
  }

  start(options: { mode?: DiagnosticMode; notes?: string; browser?: string } = {}): void {
    if (this.state === "recording") throw new Error("Stop the current diagnostic recording first");
    if (!this.connection) throw new Error("Connect a smart cube before recording diagnostics");
    this.origin = this.now();
    this.startedAt = new Date(this.wallNow()).toISOString();
    this.state = "recording";
    this.reason = null;
    this.finalSummary = null;
    this.events = [];
    this.intervals = []; this.dispatch = []; this.moveHandling = []; this.planner = [];
    this.gyro = this.moves = this.invalid = this.invalidTimes = this.nonIncreasing = 0;
    this.epoch = 0;
    this.marker = null;
    this.resetEpoch();
    this.mode = options.mode ?? "unknown";
    this.notes = (options.notes ?? "").slice(0, 2_000);
    this.browser = (options.browser ?? "").slice(0, 300);
    this.recordConnection();
  }

  stop(reason: DiagnosticStopReason = "manual"): void {
    if (this.state !== "recording") return;
    this.stoppedAt = reason === "duration-limit" ? this.origin + this.maxDurationMs : this.now();
    this.state = "stopped";
    this.reason = reason;
    this.finalSummary = this.summary();
  }

  private canRecord(): boolean {
    if (this.state !== "recording") return false;
    if (this.now() - this.origin >= this.maxDurationMs) this.stop("duration-limit");
    if (this.events.length >= this.maxEvents) this.stop("event-limit");
    return this.state === "recording";
  }

  private append(type: DiagnosticEvent["type"], data: DiagnosticEvent["data"], at = this.now()): boolean {
    if (!this.canRecord()) return false;
    this.events.push({ ordinal: this.events.length, epoch: this.epoch, atMs: at - this.origin, type, data });
    return true;
  }

  mark(label: string): void {
    if (!this.append("MARKER", { label: label.slice(0, 200) })) return;
    this.marker = label.slice(0, 200);
    this.reference = null;
    this.angle = this.maxAngle = null;
  }

  visibility(state: string): void { this.append("VISIBILITY", { state: state.slice(0, 20) }); }

  timing(name: "move-handler" | "planner", durationMs: number, operation?: string): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (this.append("TIMING", { name, durationMs, operation: text(operation) })) {
      (name === "planner" ? this.planner : this.moveHandling).push(durationMs);
    }
  }

  receive({ event, receivedAt }: GanDiagnosticPacket): void {
    const raw = event as Record<string, unknown>;
    if (event.type === "HARDWARE" && this.connection) this.connection.hardware = hardwareInfo(event);
    if (event.type === "FACELETS" && this.connection) this.connection.facelets = text(raw.facelets, 54);
    if (event.type === "DISCONNECT") { this.disconnect(); return; }
    if (!this.connection || !this.canRecord() || !Number.isFinite(receivedAt)) return;
    const relative = (value: unknown) => { const n = finite(value); return n === null ? null : n - this.origin; };
    if (event.type === "HARDWARE") {
      this.append("HARDWARE", { ...this.connection.hardware }, receivedAt);
    } else if (event.type === "FACELETS") {
      this.append("FACELETS", { facelets: this.connection.facelets, serial: finite(raw.serial) }, receivedAt);
    } else if (event.type === "MOVE") {
      const local = finite(raw.localTimestamp);
      if (!this.append("MOVE", { move: text(raw.move, 16), serial: finite(raw.serial),
        cubeTimestamp: finite(raw.cubeTimestamp), localTimestampMs: relative(local),
        eventTimestampMs: relative(raw.timestamp) }, receivedAt)) return;
      this.moves++;
      // Host callback dispatch only. This cannot measure radio or sensor latency.
      if (local !== null && receivedAt >= local) this.dispatch.push(receivedAt - local);
    } else if (event.type === "GYRO") {
      const q = object(raw.quaternion);
      const components = [finite(q.x), finite(q.y), finite(q.z), finite(q.w)];
      const norm = components.every((n) => n !== null) ? Math.hypot(...components as number[]) : null;
      const issue = norm === null ? "non-finite-or-missing-component" :
        norm === 0 ? "zero-norm" : Math.abs(norm - 1) > 0.05 ? "non-unit-norm" : null;
      const velocity = object(raw.velocity);
      if (!this.append("GYRO", {
        eventTimestampMs: relative(raw.timestamp), quaternion: { x: components[0]!, y: components[1]!, z: components[2]!, w: components[3]! },
        norm: finite(norm), issue,
        velocity: raw.velocity === undefined ? null : { x: finite(velocity.x), y: finite(velocity.y), z: finite(velocity.z) },
      }, receivedAt)) return;
      this.gyro++;
      if (finite(raw.timestamp) === null) this.invalidTimes++;
      if (this.lastGyroAt !== null) {
        const delta = receivedAt - this.lastGyroAt;
        if (delta > 0) this.intervals.push(delta); else this.nonIncreasing++;
      }
      this.lastGyroAt = receivedAt;
      this.lastQuaternion = components;
      if (issue !== null) { this.invalid++; this.angle = null; return; }
      this.validInEpoch++;
      const normalized = (components as number[]).map((n) => n / norm!);
      this.reference ??= normalized;
      const dot = normalized.reduce((sum, n, i) => sum + n * this.reference![i]!, 0);
      this.angle = 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
      this.maxAngle = Math.max(this.maxAngle ?? 0, this.angle);
    }
  }

  summary(): DiagnosticSummary {
    if (this.finalSummary) return this.finalSummary;
    if (this.state === "recording" && this.now() - this.origin >= this.maxDurationMs) {
      this.stop("duration-limit");
      return this.finalSummary!;
    }
    if (this.state === "recording" && this.events.length >= this.maxEvents) {
      this.stop("event-limit");
      return this.finalSummary!;
    }
    const end = this.state === "stopped" ? this.stoppedAt : this.now();
    const age = this.lastGyroAt === null ? null : Math.max(0, end - this.lastGyroAt);
    const sum = this.intervals.reduce((a, b) => a + b, 0);
    return {
      state: this.state, stopReason: this.reason, durationMs: this.state === "idle" ? 0 : end - this.origin,
      events: this.events.length, moves: this.moves, gyroSamples: this.gyro, invalidQuaternions: this.invalid,
      invalidGyroTimestamps: this.invalidTimes, nonIncreasingArrivalTimes: this.nonIncreasing,
      intervalsMs: diagnosticDistribution(this.intervals), observedHz: sum > 0 ? 1_000 * this.intervals.length / sum : null,
      gapsOver500Ms: this.intervals.filter((n) => n > 500).length + Number(age !== null && age > 500),
      latestGyroAgeMs: age,
      stream: !this.connection ? "disconnected" : age === null ? "waiting" : age > 500 ? "stale" :
        this.validInEpoch === 0 ? "invalid" : "receiving",
      reportedSupport: this.connection?.hardware.gyroSupported ?? null, validInCurrentEpoch: this.validInEpoch,
      quaternion: this.lastQuaternion, angleFromMarkerDegrees: this.angle, maxAngleFromMarkerDegrees: this.maxAngle,
      marker: this.marker, hostDispatchMs: diagnosticDistribution(this.dispatch),
      moveHandlingMs: diagnosticDistribution(this.moveHandling), plannerMs: diagnosticDistribution(this.planner),
    };
  }

  export(): DiagnosticCapture {
    if (this.state === "idle") throw new Error("Record diagnostics before exporting");
    this.stop();
    // Freeze a JSON-safe snapshot. Caller edits cannot change a later export.
    return JSON.parse(JSON.stringify({
      format: "cubing-companion.gyro-diagnostic", schemaVersion: 1, startedAt: this.startedAt,
      mode: { value: this.mode, source: "user-reported" }, notes: this.notes, browser: this.browser,
      clock: "host performance.now, milliseconds relative to capture start",
      limits: { maxEvents: this.maxEvents, maxDurationMs: this.maxDurationMs },
      summary: this.summary(), events: this.events,
    })) as DiagnosticCapture;
  }
}
