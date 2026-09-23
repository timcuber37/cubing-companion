"use client";

import { useEffect, useRef, useState } from "react";
import {
  captureProtocolFrames,
  isWebBluetoothAvailable,
  WebBluetoothTransport,
  type CaptureSummary,
  type ProtocolCaptureSession,
} from "@cubing-companion/cube-link";

const button =
  "rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Records a cube's raw protocol frames, for building the protocol driver against.
 *
 * Separate from the gyro diagnostics panel on purpose, in two ways that matter. It opens its own
 * BLE connection, because it subscribes to the same characteristic the library does and two owners
 * of one characteristic is not a thing. And its export **contains the cube's MAC address**, which
 * the gyro export deliberately omits — the frames are AES-encrypted with a key salted from it, so
 * a capture without it is noise. That is said plainly below rather than buried, because it is a
 * different promise than the other export makes.
 *
 * The capture is passive: it writes down what the cube says and cannot ask it anything, because
 * building a command means encrypting it and that encoder is the thing this fixture exists to
 * build. So: connect, turn the cube for a couple of minutes, export.
 */
export function ProtocolCapture() {
  const [session, setSession] = useState<ProtocolCaptureSession | null>(null);
  const [summary, setSummary] = useState<CaptureSummary | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [exported, setExported] = useState(false);
  /**
   * `null` until checked on the client.
   *
   * Feature-detecting during render would make the server say "unavailable" and the client say
   * "available", which is a hydration mismatch — React discards the tree and re-renders. So the
   * first render is the same on both sides, and the answer arrives in an effect.
   */
  const [available, setAvailable] = useState<boolean | null>(null);
  const downloadUrl = useRef<string | null>(null);

  useEffect(() => setAvailable(isWebBluetoothAvailable()), []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setSummary(session.summary()), 250);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(
    () => () => {
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    },
    [],
  );

  const start = async () => {
    setConnecting(true);
    setError(null);
    try {
      const started = await captureProtocolFrames(new WebBluetoothTransport(), { notes });
      setSession(started);
      setSummary(started.summary());
      setExported(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  const stop = () => {
    session?.stop();
    if (session) setSummary(session.summary());
  };

  const download = () => {
    if (!session) return;
    try {
      session.stop();
      const capture = session.export();
      setSummary(session.summary());
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }),
      );
      downloadUrl.current = url;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gan-frames-${capture.protocol}-${capture.startedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setExported(true);
      setError(null);
    } catch (cause) {
      setError(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const recording = summary?.state === "recording";

  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <summary className="cursor-pointer text-sm font-medium text-neutral-200">
        Protocol capture
        {recording && <span className="ml-2 text-emerald-400">● Recording</span>}
      </summary>
      <div className="mt-3 space-y-3 text-xs text-neutral-400">
        <p>
          Records the cube&apos;s raw encrypted frames so the protocol decoder can be built and
          tested against real hardware instead of a reading of someone else&apos;s source. One
          capture is enough.
        </p>
        <p className="text-neutral-200">
          <strong>Disconnect the cube above first.</strong> This opens its own connection to the
          same characteristic, and the two will fight over it.
        </p>
        <p className="text-amber-200">
          The exported file contains your cube&apos;s Bluetooth MAC address. It has to: the frames
          are encrypted with a key derived from it, and without it the file is unreadable. It
          identifies the cube, not you — but share it knowingly.
        </p>

        <label className="block space-y-1">
          <span className="block">Capture notes</span>
          <input
            value={notes}
            disabled={recording}
            maxLength={2000}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. GAN i Carry 4, two minutes of normal solving"
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-neutral-200"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void start()}
            disabled={available !== true || connecting || recording}
            className={button}
          >
            {connecting ? "Connecting…" : "Connect and record frames"}
          </button>
          <button type="button" onClick={stop} disabled={!recording} className={button}>
            Stop
          </button>
          <button type="button" onClick={download} disabled={!session} className={button}>
            {recording ? "Stop and export JSON" : "Export JSON"}
          </button>
        </div>

        {available === false && (
          <p>
            Web Bluetooth is unavailable here. This capture needs Chrome or Edge on desktop, or
            Chrome on Android.
          </p>
        )}
        {error && (
          <p className="text-red-300" role="alert">
            {error}
          </p>
        )}
        {summary?.stopReason && summary.stopReason !== "manual" && (
          <p className="text-amber-200">
            {summary.stopReason === "disconnected"
              ? "The cube disconnected. Export what was captured before trying again."
              : `Capture stopped at its ${summary.stopReason === "frame-limit" ? "frame" : "duration"} limit. Export it before starting another.`}
          </p>
        )}
        {exported && <p className="text-emerald-300">Exported. Commit it as a test fixture.</p>}

        {summary && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Stat label="Protocol" value={summary.protocol} />
            <Stat label="Frames" value={String(summary.frames)} />
            <Stat label="Bytes" value={String(summary.bytes)} />
            <Stat label="Recorded time" value={`${(summary.durationMs / 1000).toFixed(1)} s`} />
            <Stat
              label="Frame sizes"
              value={summary.frameSizes.length === 0 ? "—" : summary.frameSizes.join(", ")}
            />
            <Stat label="MAC from" value={summary.macSource} />
          </div>
        )}

        <p>
          Turn the cube normally for a couple of minutes — moves are pushed by the cube, so no
          scramble or solve structure is needed. Periodic facelet and battery reports arrive
          unprompted too. Only genuine request/response traffic — hardware info, move history — is
          out of reach, since asking requires the encoder this capture is for.
        </p>
      </div>
    </details>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div>{label}</div>
      <div className="font-mono text-neutral-200">{value}</div>
    </div>
  );
}
