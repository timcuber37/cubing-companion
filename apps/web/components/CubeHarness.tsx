"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectSmartCube,
  CubeTracker,
  isWebBluetoothAvailable,
  ManualSource,
  type CubeSource,
  type DesyncEvent,
  type TimedMove,
} from "@cubing-companion/cube-link";
import { NotationError } from "@cubing-companion/engine";
import { TwistyPlayer, type TwistyHandle } from "./TwistyPlayer";
import { MoveLog } from "./MoveLog";
import { ManualInput } from "./ManualInput";

const MAC_STORAGE_KEY = "cubing-companion.gan-mac";
const MAX_LOG = 200;

type Status =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected"; name: string; kind: string }
  | { state: "error"; message: string };

/**
 * Asks for the cube's MAC address, remembering the answer.
 *
 * GAN cubes derive their encryption key from the MAC, and Web Bluetooth deliberately does
 * not expose it. The library recovers it automatically on most platforms; this is the
 * fallback for when it cannot, and it is the most likely first-run snag.
 */
function promptForMac(deviceName: string | undefined, isRetry: boolean): string | null {
  const stored = window.localStorage.getItem(MAC_STORAGE_KEY);
  if (stored && !isRetry) return stored;

  const entered = window.prompt(
    `Enter the MAC address for ${deviceName ?? "your cube"} (format AB:CD:EF:12:34:56).\n\n` +
      "GAN cubes need this to decrypt their traffic, and the browser will not reveal it. " +
      "You can find it in the GAN app, or on some cubes printed inside the battery cover.",
    stored ?? "",
  );
  if (!entered) return null;

  const trimmed = entered.trim();
  window.localStorage.setItem(MAC_STORAGE_KEY, trimmed);
  return trimmed;
}

export function CubeHarness() {
  const playerRef = useRef<TwistyHandle>(null);
  const sourceRef = useRef<CubeSource | null>(null);
  const trackerRef = useRef<CubeTracker | null>(null);
  const manualRef = useRef<ManualSource | null>(null);

  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [moves, setMoves] = useState<TimedMove[]>([]);
  const [desyncs, setDesyncs] = useState<DesyncEvent[]>([]);
  const [skew, setSkew] = useState<number | null>(null);
  const [bluetoothAvailable, setBluetoothAvailable] = useState(true);

  // Checked after mount: `navigator` does not exist during server rendering.
  useEffect(() => {
    setBluetoothAvailable(isWebBluetoothAvailable());
  }, []);

  const teardown = useCallback(async () => {
    await trackerRef.current?.stop();
    await sourceRef.current?.disconnect();
    trackerRef.current = null;
    sourceRef.current = null;
    manualRef.current = null;
  }, []);

  useEffect(() => () => void teardown(), [teardown]);

  /** Wire a source up to the tracker, the player, and the on-screen log. */
  const attach = useCallback(async (source: CubeSource) => {
    await teardown();
    sourceRef.current = source;

    const tracker = new CubeTracker(source);
    trackerRef.current = tracker;
    setMoves([]);
    setDesyncs([]);

    tracker.onMove((move) => {
      playerRef.current?.addMove(move.move);
      setMoves((previous) => [move, ...previous].slice(0, MAX_LOG));
      setSkew(tracker.skewPercent());
    });

    tracker.onDesync((event) => {
      setDesyncs((previous) => [event, ...previous].slice(0, 20));
    });

    // A re-seed means the tracked position was replaced; the virtual cube has to jump
    // rather than animate, because the moves in between were never observed.
    tracker.onReseed((state) => playerRef.current?.setState(state));

    source.onDisconnect(() => {
      setStatus({ state: "idle" });
    });

    await tracker.start();
    setStatus({
      state: "connected",
      name: source.name ?? "Cube",
      kind: source.kind,
    });
  }, [teardown]);

  const connectCube = useCallback(async () => {
    setStatus({ state: "connecting" });
    try {
      const source = await connectSmartCube({
        macAddressPrompt: async (device, isRetry) =>
          promptForMac(device.name, isRetry),
      });
      await attach(source);
    } catch (cause) {
      setStatus({
        state: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [attach]);

  const useManual = useCallback(async () => {
    const source = new ManualSource();
    // Set *after* attaching: attach() tears down the previous source first, and teardown
    // clears this ref. Assigning beforehand would immediately be undone.
    await attach(source);
    manualRef.current = source;
  }, [attach]);

  const applyAlg = useCallback((text: string) => {
    const manual = manualRef.current;
    if (!manual) return "Start manual input first.";
    try {
      manual.applyAlg(text);
      return null;
    } catch (cause) {
      return cause instanceof NotationError ? cause.message : String(cause);
    }
  }, []);

  const pressKey = useCallback((key: string) => {
    return manualRef.current?.pressKey(key) ?? false;
  }, []);

  const connected = status.state === "connected";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="space-y-4">
        <TwistyPlayer ref={playerRef} />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void connectCube()}
            disabled={status.state === "connecting" || !bluetoothAvailable}
            className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
          >
            {status.state === "connecting" ? "Connecting…" : "Connect smart cube"}
          </button>
          <button
            type="button"
            onClick={() => void useManual()}
            className="rounded-md border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-800"
          >
            Manual input
          </button>
          {connected && (
            <button
              type="button"
              onClick={() => void teardown().then(() => setStatus({ state: "idle" }))}
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800"
            >
              Disconnect
            </button>
          )}
        </div>

        <StatusLine
          status={status}
          skew={skew}
          bluetoothAvailable={bluetoothAvailable}
        />

        {connected && status.kind === "manual" && (
          <ManualInput onApply={applyAlg} onKey={pressKey} />
        )}
      </section>

      <section className="space-y-4">
        <DesyncPanel events={desyncs} />
        <MoveLog moves={moves} />
      </section>
    </div>
  );
}

function StatusLine({
  status,
  skew,
  bluetoothAvailable,
}: {
  status: Status;
  skew: number | null;
  bluetoothAvailable: boolean;
}) {
  if (!bluetoothAvailable) {
    return (
      <p className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
        This browser has no Web Bluetooth, so it cannot talk to a smart cube. Use Chrome or
        Edge on desktop, or Chrome on Android — Safari and iOS do not support it at all.
        Manual input works anywhere.
      </p>
    );
  }

  if (status.state === "error") {
    return (
      <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        {status.message}
      </p>
    );
  }

  if (status.state !== "connected") {
    return (
      <p className="text-sm text-neutral-500">
        Not connected. Connecting a cube needs a click — the browser will not show its
        device chooser otherwise.
      </p>
    );
  }

  return (
    <p className="text-sm text-neutral-400">
      <span className="font-medium text-emerald-400">Connected</span> to {status.name}{" "}
      <span className="text-neutral-600">({status.kind})</span>
      {skew !== null && (
        <>
          {" · "}cube clock {skew >= 0 ? "+" : ""}
          {skew.toFixed(2)}% vs host
        </>
      )}
    </p>
  );
}

function DesyncPanel({ events }: { events: DesyncEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 px-3 py-2 text-sm text-neutral-500">
        Not tracking yet.
      </div>
    );
  }

  // Named for what it holds rather than for the failure case: an `initial-sync` is normal
  // startup, and filing it under "desyncs" makes a healthy connection look broken.
  return (
    <div className="space-y-1 rounded-md border border-neutral-800 p-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Sync events
      </h2>
      <ul className="space-y-1 text-xs">
        {events.map((event, index) => (
          <li key={index} className="text-neutral-400">
            <span
              className={
                event.reason === "initial-sync" ? "text-sky-400" : "text-amber-400"
              }
            >
              {event.reason === "initial-sync" ? "seeded from cube" : event.reason}
            </span>
            {event.reason === "serial-gap" && ` — ${event.actual}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
