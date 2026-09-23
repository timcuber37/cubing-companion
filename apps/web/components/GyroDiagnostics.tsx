"use client";

import { useEffect, useRef, useState } from "react";
import { GanDiagnosticRecorder, type DiagnosticMode, type GanCubeSource } from "@cubing-companion/cube-link";
import { toFacelets } from "@cubing-companion/engine";
import { onDiagnosticTiming } from "./diagnosticTimings";

const STEPS = [
  ["still-60s", "Hold still — 60 seconds", "Set the cube on a stable surface. Mark the step, then leave it still for 60 seconds."],
  ["still-5m", "Hold still — 5 minutes", "Use a separate recording for the longer drift check. Leave the cube still for five minutes."],
  ["x", "x rotations", "Rotate the whole cube like R: x, pause, x′, pause, x2. Pause two seconds between movements."],
  ["y", "y rotations", "Rotate the whole cube like U: y, pause, y′, pause, y2. Pause two seconds between movements."],
  ["z", "z rotations", "Rotate the whole cube like F: z, pause, z′, pause, z2. Pause two seconds between movements."],
  ["fast-rotations", "Fast rotations", "Repeat the rotations at your normal solving speed, including consecutive rotations and a return to the starting hold."],
  ["face-turns", "Face turns and natural tilt", "Keep roughly the same hold and perform R U R′ U′ several times. Include your ordinary wrist movement."],
  ["wide-slice", "Wide and slice turns", "Perform several wide and slice turns. These help distinguish core motion from deliberate cube rotations."],
  ["solve", "Normal solve", "Mark before scrambling and solving normally. A video can later help label when rotations actually happened."],
  ["reconnect", "Reconnect / wake", "Disconnect and reconnect using the app controls while recording continues. This checks the boundaries between streams."],
] as const;

const button = "rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40";
const numeric = (n: number | null, unit = "", digits = 1) => n === null ? "—" : `${n.toFixed(digits)}${unit}`;

/** This panel stays mounted across connection changes so a trace can include reconnects. */
export function GyroDiagnostics({ source }: { source: GanCubeSource | null }) {
  const [recorder] = useState(() => new GanDiagnosticRecorder());
  const [summary, setSummary] = useState(() => recorder.summary());
  const [mode, setMode] = useState<DiagnosticMode>("unknown");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(true);
  const downloadUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!source) { recorder.disconnect(); return; }
    const state = source.lastKnownState();
    recorder.connect(source.getTransportInfo(), source.getHardware(), state ? toFacelets(state) : null);
    const unsubscribe = source.onDiagnostic((packet) => recorder.receive(packet));
    const offDisconnect = source.onDisconnect(() => recorder.disconnect());
    return () => { unsubscribe(); offDisconnect(); recorder.disconnect(); };
  }, [source, recorder]);

  useEffect(() => {
    const update = () => setSummary(recorder.summary());
    const timer = window.setInterval(update, 500);
    const visibility = () => recorder.visibility(document.visibilityState);
    document.addEventListener("visibilitychange", visibility);
    const offTiming = onDiagnosticTiming((name, ms, operation) => recorder.timing(name, ms, operation));
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      offTiming();
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    };
  }, [recorder]);

  const requestHardware = async () => {
    if (!source) return;
    setError(null);
    try { await source.requestHardware(); }
    catch (cause) { setError(`Hardware request failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  const start = () => {
    try {
      recorder.start({ mode, notes, browser: navigator.userAgent });
      recorder.visibility(document.visibilityState);
      setSummary(recorder.summary());
      setExported(false);
      setError(null);
      void requestHardware();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const download = () => {
    try {
      const capture = recorder.export();
      setSummary(recorder.summary());
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
      downloadUrl.current = url;
      const a = document.createElement("a");
      a.href = url;
      a.download = `gan-gyro-${capture.startedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExported(true);
      setError(null);
    } catch (cause) { setError(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  const recording = summary.state === "recording";
  const activeStep = STEPS[step]!;
  const transport = source?.getTransportInfo();
  const hardware = source?.getHardware();
  const streamLabel = summary.state === "idle" ? "Start a recording to inspect the stream" :
    !recording ? "Recording stopped" : {
      disconnected: "Disconnected — recording can continue after reconnect",
      waiting: "Waiting for orientation samples",
      receiving: "Receiving orientation samples",
      stale: "Orientation stream paused (over 500 ms)",
      invalid: "Receiving samples with invalid quaternions",
    }[summary.stream];

  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-200">
        Gyro diagnostics {recording && <span className="ml-2 text-emerald-400">● Recording</span>}
      </summary>
      <div className="mt-3 space-y-3 text-xs text-neutral-400">
        <p>Record the GAN i4 orientation stream and face turns for the hardware check. Recordings stay in memory until you export them; export before reloading this page.</p>
        <p className="text-neutral-200" role="status">{streamLabel}</p>
        <p>
          {hardware?.hardwareName ?? "Model awaiting hardware reply"} · firmware {hardware?.softwareVersion ?? "?"}
          {" · "}reported gyro {hardware?.gyroSupported === true ? "yes" : hardware?.gyroSupported === false ? "no" : "?"}
          {" · "}{transport?.protocol ?? "unknown protocol"}
        </p>
        {summary.reportedSupport === false && summary.validInCurrentEpoch > 0 && (
          <p className="text-amber-200">The hardware flag says no, but usable orientation samples arrived. The recording preserves both observations.</p>
        )}
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1">
            <span className="block">Cube mode (if you know it)</span>
            <select value={mode} disabled={recording} onChange={(event) => setMode(event.target.value as DiagnosticMode)} className="rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-200">
              <option value="unknown">Unknown</option>
              <option value="performance">Performance / gyro on</option>
              <option value="endurance">Endurance / gyro off</option>
            </select>
          </label>
          <label className="min-w-48 flex-1 space-y-1">
            <span className="block">Recording notes</span>
            <input value={notes} disabled={recording} maxLength={2000} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. GAN i4, first test, cube on desk" className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-200" />
          </label>
        </div>
        <p>Mode is your label for this recording; selecting it does not change the cube&apos;s settings.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={start} disabled={!source || recording || !exported} className={button}>Start recording</button>
          <button type="button" onClick={() => { recorder.stop(); setSummary(recorder.summary()); }} disabled={!recording} className={button}>Stop</button>
          <button type="button" onClick={download} disabled={summary.state === "idle"} className={button}>{recording ? "Stop and export JSON" : "Export JSON"}</button>
          <button type="button" onClick={() => void requestHardware()} disabled={!source} className={button}>Request hardware info</button>
        </div>
        {!source && <p>Connect your smart cube with the controls above to begin.</p>}
        {!recording && !exported && <p>Export this recording to enable the next one.</p>}
        {error && <p className="text-red-300" role="alert">{error}</p>}
        {summary.stopReason && summary.stopReason !== "manual" && <p className="text-amber-200">Recording stopped at its {summary.stopReason === "event-limit" ? "30,000-event" : "10-minute"} limit. Export this partial trace before starting another.</p>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <Stat label="Recorded time" value={numeric(summary.durationMs / 1000, " s")} />
          <Stat label="Gyro samples / face turns" value={`${summary.gyroSamples} / ${summary.moves}`} />
          <Stat label="Observed arrival rate" value={numeric(summary.observedHz, " Hz")} />
          <Stat label="Intervals p50 / p95" value={`${numeric(summary.intervalsMs.p50)} / ${numeric(summary.intervalsMs.p95, " ms")}`} />
          <Stat label="Longest completed interval" value={numeric(summary.intervalsMs.max, " ms")} />
          <Stat label="Latest sample age" value={numeric(summary.latestGyroAgeMs, " ms")} />
          <Stat label="Gaps over 500 ms" value={String(summary.gapsOver500Ms)} />
          <Stat label="Invalid quaternions" value={String(summary.invalidQuaternions)} />
          <Stat label="Missing gyro timestamps" value={String(summary.invalidGyroTimestamps)} />
          <Stat label="Host dispatch p50 / p95" value={`${numeric(summary.hostDispatchMs.p50, "", 2)} / ${numeric(summary.hostDispatchMs.p95, " ms", 2)}`} />
          <Stat label="Move handler p50 / p95" value={`${numeric(summary.moveHandlingMs.p50, "", 2)} / ${numeric(summary.moveHandlingMs.p95, " ms", 2)}`} />
          <Stat label="Planner p50 / p95" value={`${numeric(summary.plannerMs.p50)} / ${numeric(summary.plannerMs.p95, " ms")}`} />
        </div>
        <p>Arrival rate and host dispatch measure browser delivery. They do not establish sensor or Bluetooth latency. Planner timings combine completed requests; exports label each request type.</p>
        <div className="space-y-2 border-t border-neutral-800 pt-3">
          <label className="block space-y-1">
            <span className="block text-neutral-200">Test step</span>
            <select value={step} onChange={(event) => setStep(Number(event.target.value))} className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-200">
              {STEPS.map(([id, title], index) => <option key={id} value={index}>{index + 1}. {title}</option>)}
            </select>
          </label>
          <p>{activeStep[2]}</p>
          <p>For rotation tests, start with white up and green facing you. Mark the step, then pause two seconds before moving.</p>
          <button type="button" disabled={!recording} onClick={() => { recorder.mark(activeStep[0]); setSummary(recorder.summary()); }} className={button}>Mark step start</button>
          <p>Last marker: {summary.marker ?? "none"}. Angle from its first valid sample: {numeric(summary.angleFromMarkerDegrees, "°", 2)}; maximum {numeric(summary.maxAngleFromMarkerDegrees, "°", 2)}.</p>
          <p>This relative angle helps inspect a still hold. Motion contributes to it; it is not a calibrated rotation count or proof of drift.</p>
          <p className="break-all font-mono">Raw quaternion [x, y, z, w]: {summary.quaternion?.map((v) => numeric(v, "", 5)).join(", ") ?? "—"}</p>
        </div>
        <p>Exports contain decoded samples, turns, firmware, BLE service UUIDs, browser version, notes, and test markers. Device addresses and encryption keys are omitted. The virtual cube still follows face turns during this diagnostic phase.</p>
      </div>
    </details>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div>{label}</div><div className="font-mono text-neutral-200">{value}</div></div>;
}
