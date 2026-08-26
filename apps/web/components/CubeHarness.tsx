"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectSmartCube,
  CubeTracker,
  isWebBluetoothAvailable,
  ManualSource,
  GanCubeSource,
  type CubeSource,
  type DesyncEvent,
  type GanHardwareInfo,
  type TimedMove,
} from "@cubing-companion/cube-link";
import {
  applyMoves,
  CubeState,
  generateScramble,
  NotationError,
  parseMoves,
  toFacelets,
} from "@cubing-companion/engine";
import {
  MemoryStore,
  SolveRecorder,
  type RecorderState,
  type SolveRecord,
  type SolveStore,
} from "@cubing-companion/session";
import { TwistyPlayer, type TwistyHandle } from "./TwistyPlayer";
import { MoveLog } from "./MoveLog";
import { ManualInput } from "./ManualInput";
import { SessionPanel } from "./SessionPanel";
import { SolveList } from "./SolveList";
import { SolveDetail } from "./SolveDetail";
import { PlannerPanel } from "./PlannerPanel";

const MAC_STORAGE_KEY = "cubing-companion.gan-mac";
const SESSION_KEY = "cubing-companion.session-id";
const MAX_LOG = 200;

const IDLE_RECORDER: RecorderState = {
  phase: "idle",
  scrambleText: null,
  moveCount: 0,
  elapsedMs: null,
  record: null,
};

/**
 * One session per browser, reused across reloads.
 *
 * Keyed in localStorage rather than created fresh each load, so refreshing mid-session does
 * not split the solves into two groups.
 */
function sessionId(): string {
  const existing = window.localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = `session-${Date.now()}`;
  window.localStorage.setItem(SESSION_KEY, created);
  return created;
}

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
/**
 * Ask for the cube's MAC address, but only once it is genuinely needed.
 *
 * The library calls this **twice**: once before it tries to detect the address itself, and again
 * as a last resort if that failed. Answering the first call put a dialog in front of every user,
 * including the great majority whose cube is detected automatically — so the first call declines
 * and lets the library do its job.
 *
 * The fallback is kept rather than deleted: browsers without `watchAdvertisements` cannot detect
 * it at all, and for them typing it in is the difference between a working cube and a dead one.
 */
function promptForMac(deviceName: string | undefined, isRetry: boolean): string | null {
  // Not the last resort yet — let the library try the advertisement data first. It is more
  // reliable than anything remembered here, which could be a different cube entirely.
  if (!isRetry) return null;

  const stored = window.localStorage.getItem(MAC_STORAGE_KEY);
  const entered = window.prompt(
    `Enter the MAC address for ${deviceName ?? "your cube"} (format AB:CD:EF:12:34:56).\n\n` +
      "This cube's address could not be detected automatically. GAN cubes need it to decrypt " +
      "their traffic, and the browser will not reveal it.\n\n" +
      "Enabling chrome://flags/#enable-experimental-web-platform-features usually fixes this " +
      "for good. Otherwise read it from chrome://bluetooth-internals (Devices \u2192 Start Scan), " +
      "a phone Bluetooth scanner, or inside the battery cover.",
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
  const recorderRef = useRef<SolveRecorder | null>(null);
  const storeRef = useRef<SolveStore | null>(null);
  const [recorderState, setRecorderState] = useState<RecorderState>(IDLE_RECORDER);
  const [solves, setSolves] = useState<SolveRecord[]>([]);
  const [scrambling, setScrambling] = useState(false);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const [scrambleKind, setScrambleKind] = useState<"random-state" | "random-move" | null>(null);
  // The id rather than the record: the list is reloaded from storage after every change, and
  // holding a stale copy would keep showing a solve that had been deleted.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // What the cube says it is. Chiefly for `gyroSupported`: it decides whether whole-cube
  // rotations can ever be observed, and the answer depends on the protocol generation rather
  // than on the model name printed on the box.
  const [hardware, setHardware] = useState<GanHardwareInfo | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // The live position, as a facelet string, for the planner to read. Kept as facelets rather
  // than a `CubeState` because that is what crosses into the worker anyway.
  const [facelets, setFacelets] = useState<string | null>(null);

  // Checked after mount: `navigator` does not exist during server rendering.
  useEffect(() => {
    setBluetoothAvailable(isWebBluetoothAvailable());
  }, []);

  // Storage is opened lazily and client-only: `IndexedDbStore` is imported here rather than
  // at module scope so server rendering never touches `indexedDB`, the same pattern the
  // twisty player and the BLE library use.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { IndexedDbStore, isIndexedDbAvailable } = await import(
        "@cubing-companion/session"
      );
      if (cancelled) return;
      let store: SolveStore;
      if (isIndexedDbAvailable()) {
        store = new IndexedDbStore();
      } else {
        // Private browsing can refuse to open a database. Falling back keeps the app usable
        // rather than failing to load; the note tells the user solves will not persist.
        store = new MemoryStore();
        setStorageNote("Storage unavailable — solves will be lost on reload.");
      }
      try {
        const id = sessionId();
        await store.ensureSession({ id, startedAt: Date.now(), label: "Session" });
        storeRef.current = store;
        setSolves(await store.listSolves(id));
      } catch (cause) {
        storeRef.current = new MemoryStore();
        setStorageNote(
          `Storage failed to open (${cause instanceof Error ? cause.message : String(cause)}); solves will not persist.`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist a finished record and refresh the list. */
  const saveRecord = useCallback(async (record: SolveRecord) => {
    const store = storeRef.current;
    if (!store) return;
    await store.putSolve(record);
    setSolves(await store.listSolves(record.sessionId));
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

    setHardware(null);
    if (source instanceof GanCubeSource) {
      source.onHardware((info) => {
        setHardware(info);
        // Logged as well as shown: this is the first thing worth knowing when a cube behaves
        // unexpectedly, and pasting a console line is quicker than reading it off the screen.
        console.info("[cube] hardware", info);
      });
    }
    setMoves([]);
    setDesyncs([]);

    const recorder = new SolveRecorder({
      sessionId: sessionId(),
      source: source.kind,
    });
    recorderRef.current = recorder;
    setRecorderState(recorder.getState());

    tracker.onMove((move) => {
      playerRef.current?.addMove(move.move);
      setMoves((previous) => [move, ...previous].slice(0, MAX_LOG));
      setSkew(tracker.skewPercent());
      setFacelets(toFacelets(tracker.getState()));

      // Order matters: the move that solves the cube must be recorded as part of the solve,
      // so the recorder sees it before it sees the resulting position.
      const before = recorder.getState().phase;
      recorder.handleMove(move);
      recorder.handleState(tracker.getState());
      const after = recorder.getState();
      setRecorderState(after);
      if (before !== "complete" && after.phase === "complete" && after.record) {
        void saveRecord(after.record);
      }
    });

    tracker.onDesync((event) => {
      setDesyncs((previous) => [event, ...previous].slice(0, 20));
    });

    // A re-seed means the tracked position was replaced; the virtual cube has to jump
    // rather than animate, because the moves in between were never observed.
    tracker.onReseed((state) => {
      playerRef.current?.setState(state);
      setFacelets(toFacelets(state));
      // The position changed without any move arriving, so the recorder has to be told —
      // otherwise a cube that was re-seeded straight onto the scramble would never arm.
      recorder.handleState(state);
      setRecorderState(recorder.getState());
    });

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

  const newScramble = useCallback(async () => {
    const recorder = recorderRef.current;
    const tracker = trackerRef.current;
    if (!recorder || !tracker) return;
    setScrambling(true);
    try {
      // Random-state scrambles need a WASM solver in a worker, which some bundlers cannot
      // instantiate; `generateScramble` falls back to random-move and says which it produced.
      const { text, kind } = await generateScramble();
      setScrambleKind(kind);

      // With manual input there is no cube in your hands to scramble, so scramble the virtual
      // one. Set outright rather than turned: the scramble describes solved-plus-those-moves, so
      // applying them to whatever the cube happens to be showing would land somewhere else
      // entirely — and turning them would put a scramble in the move log for the recorder to
      // count. Done before arming, so the recorder sees a cube that already matches and goes
      // straight to ready.
      const manual = manualRef.current;
      if (manual) {
        const target = applyMoves(CubeState.solved(), parseMoves(text));
        manual.setState(target);
        tracker.reseed(target);
      }

      recorder.arm(text, tracker.getState());
      setRecorderState(recorder.getState());
    } finally {
      setScrambling(false);
    }
  }, []);

  /**
   * Ask the cube what it actually shows, and put both the tracker and the display there.
   *
   * There are **two** things that can be out of step, and only one of them is what `verify`
   * fixes. It reconciles the *tracked* position against the cube. The cube on screen is a
   * separate thing again, driven move by move through the player's animation queue, and it can
   * fall behind on its own — a move that arrives while the previous one is still animating is
   * one way, and no amount of agreement between tracker and cube will pull it back.
   *
   * So the display is pushed unconditionally, not only when `verify` reports a mismatch.
   * Otherwise the common case — tracker right, screen wrong — reports "already in sync" and
   * changes nothing, which is precisely the complaint that prompted this.
   */
  const resync = useCallback(async () => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    setSyncing(true);
    try {
      const trackerWasRight = await tracker.verify();
      // `verify` only emits a re-seed when it found a mismatch, so the display has to be set
      // here rather than left to the re-seed handler.
      const state = tracker.getState();
      playerRef.current?.setState(state);
      setFacelets(toFacelets(state));
      setSyncNote(
        trackerWasRight
          ? "display re-synced from the cube"
          : "re-synced — the tracked position was off",
      );
    } catch (cause) {
      setSyncNote(cause instanceof Error ? cause.message : "could not reach the cube");
    } finally {
      setSyncing(false);
    }
  }, []);

  // The note is a confirmation, not a status: it should not linger as though it still applied.
  useEffect(() => {
    if (syncNote === null) return;
    const timer = setTimeout(() => setSyncNote(null), 4000);
    return () => clearTimeout(timer);
  }, [syncNote]);

  /**
   * Declare the cube solved, and re-base everything on that.
   *
   * `Sync` reads the cube's position and trusts it. When the cube itself has lost track — and
   * they do, if turned while asleep or if a fast half turn reads as a quarter — reading it just
   * copies the mistake faithfully, which looks exactly like sync being broken. This is the other
   * direction: put a solved cube in your hand and tell it so.
   */
  const markSolved = useCallback(async () => {
    const tracker = trackerRef.current;
    const source = sourceRef.current;
    if (!tracker) return;
    setSyncing(true);
    try {
      const solved = CubeState.solved();
      if (source instanceof GanCubeSource) {
        await source.resetToSolved();
      } else if (source instanceof ManualSource) {
        source.setState(solved);
      }
      tracker.reseed(solved);
      playerRef.current?.setState(solved);
      setFacelets(toFacelets(solved));
      setSyncNote("cube re-based as solved");
    } catch (cause) {
      setSyncNote(cause instanceof Error ? cause.message : "could not reach the cube");
    } finally {
      setSyncing(false);
    }
  }, []);

  const startFromHere = useCallback(() => {
    const recorder = recorderRef.current;
    const tracker = trackerRef.current;
    if (!recorder || !tracker) return;
    recorder.startFrom(tracker.getState());
    setRecorderState(recorder.getState());
  }, []);

  const discardSolve = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const record = recorder.discard();
    setRecorderState(recorder.getState());
    if (record) void saveRecord(record);
  }, [saveRecord]);

  const deleteSolve = useCallback(async (id: string) => {
    const store = storeRef.current;
    if (!store) return;
    await store.deleteSolve(id);
    setSolves(await store.listSolves(sessionId()));
  }, []);

  const connected = status.state === "connected";
  const selected = solves.find((solve) => solve.id === selectedId) ?? null;
  const scrambleMatched =
    recorderState.phase === "ready" || recorderState.phase === "solving";

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
              onClick={() => void resync()}
              disabled={syncing}
              title="Read the cube's actual position and match the virtual one to it."
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync"}
            </button>
          )}
          {connected && (
            <button
              type="button"
              onClick={() => void markSolved()}
              disabled={syncing}
              title="Use when the cube itself has lost track: hold a solved cube and press this to re-base it."
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              Cube is solved
            </button>
          )}
          {syncNote && <span className="text-xs text-neutral-500">{syncNote}</span>}
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
          hardware={hardware}
        />

        {connected && (
          <SessionPanel
            state={recorderState}
            scrambleKind={scrambleKind}
            scrambleMatched={scrambleMatched}
            onNewScramble={() => void newScramble()}
            onStartFromHere={startFromHere}
            onDiscard={discardSolve}
            busy={scrambling}
          />
        )}

        {connected && status.kind === "manual" && (
          <ManualInput onApply={applyAlg} onKey={pressKey} />
        )}
      </section>

      <section className="space-y-4">
        {storageNote && (
          <p className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
            {storageNote}
          </p>
        )}
        <PlannerPanel facelets={facelets} phase={recorderState.phase} />
        <SolveList
          solves={solves}
          onDelete={(id) => void deleteSolve(id)}
          onSelect={(solve) => setSelectedId(solve.id)}
        />
        <DesyncPanel events={desyncs} />
        <MoveLog moves={moves} />
      </section>

      {selected && (
        <SolveDetail
          solve={selected}
          onClose={() => setSelectedId(null)}
          // Every other timed solve, so speed is rated against you rather than against pros.
          // The solve being examined is excluded: comparing it with itself would pull the
          // reference towards whatever it happens to be.
          recentDurationsMs={solves
            .filter((s) => s.id !== selected.id && s.durationMs !== null)
            .map((s) => s.durationMs!)}
        />
      )}
    </div>
  );
}

/** Not every entry here is a fault: two of these are the app placing the cube on purpose. */
const DESYNC_LABEL: Record<string, string> = {
  "initial-sync": "seeded from cube",
  "set-directly": "scrambled",
};
const BENIGN_DESYNC = new Set(["initial-sync", "set-directly"]);

function StatusLine({
  status,
  skew,
  bluetoothAvailable,
  hardware,
}: {
  status: Status;
  skew: number | null;
  bluetoothAvailable: boolean;
  hardware: GanHardwareInfo | null;
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
      {hardware && (
        <>
          {" · "}
          <span title={`hardware ${hardware.hardwareVersion ?? "?"}, firmware ${hardware.softwareVersion ?? "?"}`}>
            {hardware.hardwareName ?? "unknown model"}
          </span>
          {" · "}
          <span
            className={hardware.gyroSupported ? "text-neutral-400" : "text-neutral-600"}
            title={
              hardware.gyroSupported
                ? "This cube reports its orientation, so whole-cube rotations could be detected."
                : "This cube does not report orientation. A rotation turns no face against the core, so nothing observes it — rotations will not appear in your solves, and are left out of the score rather than counted as zero."
            }
          >
            gyro {hardware.gyroSupported === null ? "?" : hardware.gyroSupported ? "yes" : "no"}
          </span>
        </>
      )}
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
                BENIGN_DESYNC.has(event.reason) ? "text-sky-400" : "text-amber-400"
              }
            >
              {DESYNC_LABEL[event.reason] ?? event.reason}
            </span>
            {event.reason === "serial-gap" && ` — ${event.actual}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
