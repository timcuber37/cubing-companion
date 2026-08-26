"use client";

import { useEffect, useState } from "react";
import type { RecorderState } from "@cubing-companion/session";

/**
 * The scramble and the state of the current attempt.
 *
 * The status line is the important part: with a smart cube there is no start button, so the
 * only way to know whether a turn will begin the solve is for the app to say so.
 */
export function SessionPanel({
  state,
  scrambleKind,
  scrambleMatched,
  onNewScramble,
  onStartFromHere,
  onDiscard,
  busy,
}: {
  state: RecorderState;
  scrambleKind: "random-state" | "random-move" | null;
  scrambleMatched: boolean;
  onNewScramble: () => void;
  onStartFromHere: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3 rounded-md border border-neutral-800 p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Attempt
        </h2>
        <PhaseBadge phase={state.phase} matched={scrambleMatched} />
      </div>

      {state.scrambleText ? (
        <div className="space-y-1">
          <p className="font-mono text-sm leading-relaxed text-neutral-100">
            {state.scrambleText}
          </p>
          {scrambleKind === "random-move" && (
            <p
              className="text-[11px] text-amber-500"
              title="The random-state solver could not start in this browser, so this is a random-move scramble: valid, but not uniformly distributed over positions the way a WCA scramble is."
            >
              random-move scramble (solver unavailable)
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No scramble yet.</p>
      )}

      <LiveTimer state={state} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onNewScramble}
          disabled={busy}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Scrambling…" : "New scramble"}
        </button>
        {/*
          Available whenever a solve is not already under way, not just while waiting for the
          cube to reach a scramble. Manual input now scrambles the virtual cube for you and lands
          straight in `ready`, so gating this on `scrambling` would leave no way at all to start
          from a position you set yourself — a competition scramble, or one from a tutorial.
        */}
        {state.phase !== "solving" && (
          <button
            type="button"
            onClick={onStartFromHere}
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            title="Begin from the cube's current position, ignoring the scramble above."
          >
            Start from here
          </button>
        )}
        {state.phase === "solving" && (
          <button
            type="button"
            onClick={onDiscard}
            className="rounded border border-amber-800/60 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-950/40"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}

function PhaseBadge({
  phase,
  matched,
}: {
  phase: RecorderState["phase"];
  matched: boolean;
}) {
  const label: Record<RecorderState["phase"], string> = {
    idle: "idle",
    scrambling: matched ? "matching…" : "apply the scramble",
    ready: "ready — next turn starts",
    solving: "solving",
    complete: "done",
  };
  const tone: Record<RecorderState["phase"], string> = {
    idle: "text-neutral-500",
    scrambling: "text-amber-400",
    ready: "text-emerald-400",
    solving: "text-sky-400",
    complete: "text-neutral-300",
  };
  return <span className={`text-xs ${tone[phase]}`}>{label[phase]}</span>;
}

/**
 * Elapsed time, ticking while a solve is in progress.
 *
 * Driven by an interval rather than by moves: a solver pausing mid-solve is exactly when the
 * clock most needs to keep moving, and that is the pause A3 will care about.
 */
function LiveTimer({ state }: { state: RecorderState }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (state.phase !== "solving") return;
    const handle = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(handle);
  }, [state.phase]);

  const elapsed = state.record?.durationMs ?? state.elapsedMs;
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-2xl tabular-nums text-neutral-100">
        {elapsed === null ? "—" : (elapsed / 1000).toFixed(2)}
      </span>
      <span className="text-xs text-neutral-500">
        {state.moveCount} {state.moveCount === 1 ? "move" : "moves"}
      </span>
    </div>
  );
}
