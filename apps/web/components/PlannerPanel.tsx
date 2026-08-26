"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMoves,
  CubeState,
  generateScramble,
  parseMoves,
  toFacelets,
  type Face,
} from "@cubing-companion/engine";
import { COLOURS, colourOf, type ColourPlan, type PlannedSolution } from "@cubing-companion/planner";
import { usePlanner } from "./usePlanner";

/** WCA inspection. The point of practice mode is that it is the real budget, not a comfortable one. */
const INSPECTION_MS = 15_000;
/** Long enough that turning the cube does not queue a sweep per move. */
const DEBOUNCE_MS = 400;

type Mode = "live" | "practice" | "next-pair";

/**
 * Which cross to build, and how to hold the cube to build it.
 *
 * The first feature that helps *before* a solve rather than after it. Two modes over one results
 * view: plan from the cube as it stands, or take a scramble and plan it under inspection time.
 */
export function PlannerPanel({ facelets }: { facelets: string | null }) {
  const [mode, setMode] = useState<Mode>("live");
  const [faces, setFaces] = useState<Set<Face>>(() => new Set(COLOURS.map((c) => c.face)));
  const {
    plans,
    running,
    elapsedMs,
    error,
    ranked,
    learned,
    rankedCross,
    revised,
    plan,
    rankPairs,
    reset,
  } = usePlanner();

  const [scramble, setScramble] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(INSPECTION_MS);
  const [revealed, setRevealed] = useState(false);

  const request = useCallback(
    (from: string) => plan({ facelets: from, crossFaces: [...faces], keep: 3 }),
    [faces, plan],
  );

  // Live mode re-plans as the cube changes, debounced so a burst of turns costs one sweep.
  useEffect(() => {
    if (mode !== "live" || !facelets || faces.size === 0) return;
    const timer = setTimeout(() => request(facelets), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mode, facelets, faces, request]);

  // Pair order, from B3's learned ranker. Same debounce, same live position.
  useEffect(() => {
    if (mode !== "next-pair" || !facelets || faces.size === 0) return;
    const timer = setTimeout(
      () => rankPairs({ facelets, crossFaces: [...faces] }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [mode, facelets, faces, rankPairs]);

  // Practice: the sweep runs *during* inspection, so the answer is ready the moment time is up.
  useEffect(() => {
    if (deadline === null) return;
    const tick = setInterval(() => {
      const left = deadline - Date.now();
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        setRevealed(true);
        setDeadline(null);
      }
    }, 100);
    return () => clearInterval(tick);
  }, [deadline]);

  /**
   * Hand out a scramble, but do not start the clock.
   *
   * Applying the scramble to a physical cube takes longer than the inspection it is preparing
   * for, so starting the countdown here would mean spending inspection on scrambling. The clock
   * is a separate, deliberate act — which is also how it works at a competition.
   */
  const newScramble = async () => {
    reset();
    setRevealed(false);
    setDeadline(null);
    const generated = await generateScramble();
    setScramble(generated.text);
    setRemaining(INSPECTION_MS);
    // The scramble describes a position; plan from that rather than from the cube in hand, which
    // has not been scrambled yet.
    plan({
      facelets: toFacelets(applyMoves(CubeState.solved(), parseMoves(generated.text))),
      crossFaces: [...faces],
      keep: 3,
    });
  };

  const beginInspection = () => {
    setRemaining(INSPECTION_MS);
    setDeadline(Date.now() + INSPECTION_MS);
  };

  const toggle = (face: Face) => {
    setFaces((previous) => {
      const next = new Set(previous);
      if (next.has(face)) next.delete(face);
      else next.add(face);
      // Never leave nothing selected; there would be nothing to show.
      return next.size === 0 ? previous : next;
    });
  };

  const showResults = mode === "live" || revealed;

  return (
    <section aria-label="Planner" className="rounded-md border border-neutral-800">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Planner</h2>
        <div className="flex gap-1">
          {(["live", "next-pair", "practice"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setMode(option);
                reset();
                setRevealed(false);
                setDeadline(null);
              }}
              className={`rounded px-2 py-0.5 text-xs ${
                mode === option
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {option === "live" ? "cross" : option === "next-pair" ? "which pair" : "practice"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-neutral-600">
            cross colours
          </span>
          {COLOURS.map((colour) => (
            <button
              key={colour.face}
              type="button"
              onClick={() => toggle(colour.face)}
              aria-pressed={faces.has(colour.face)}
              aria-label={colour.name}
              title={colour.name}
              className={`h-5 w-5 rounded-full border-2 transition ${
                faces.has(colour.face)
                  ? "border-neutral-100"
                  : "border-transparent opacity-30 hover:opacity-60"
              }`}
              style={{ backgroundColor: colour.hex }}
            />
          ))}
        </div>

        {mode === "practice" && (
          <PracticeControls
            scramble={scramble}
            remaining={remaining}
            inspecting={deadline !== null}
            revealed={revealed}
            onStart={() => void newScramble()}
            onBegin={beginInspection}
            onReveal={() => {
              setRevealed(true);
              setDeadline(null);
            }}
          />
        )}

        {error && <p className="text-xs text-red-400">Planner failed: {error}</p>}

        {mode === "next-pair" && (
          <NextPairAdvice
            ranked={ranked}
            learned={learned}
            crossFace={rankedCross}
            running={running}
            hasCube={facelets !== null}
          />
        )}

        {mode === "live" && !facelets && (
          <p className="text-sm text-neutral-600">
            Connect a cube, or use manual input, and the planner will read whatever position it is
            in.
          </p>
        )}

        {mode !== "next-pair" && showResults && (
          <>
            {plans.length === 0 && running && (
              <p className="text-xs text-neutral-600">Searching…</p>
            )}
            <ul className="space-y-2">
              {plans.map((colourPlan) => (
                <ColourRow key={colourPlan.crossFace} plan={colourPlan} />
              ))}
            </ul>
            {plans.length > 0 && (
              <p className="border-t border-neutral-900 pt-2 text-[11px] leading-relaxed text-neutral-600">
                Ranked shortest first.{" "}
                {revised
                  ? "Ties broken by a model trained on which cross pros actually built, which also picks the grip."
                  : "Ties broken by how pros actually turn — the back face is 2.5% of real cross moves, so a solution is shown in whichever of the four grips keeps the work off it."}
                {running
                  ? " Still searching the remaining colours…"
                  : elapsedMs !== null && ` Swept in ${(elapsedMs / 1000).toFixed(1)}s.`}
              </p>
            )}
          </>
        )}

        {mode === "practice" && !revealed && scramble && (
          <p className="text-xs text-neutral-600">
            Scramble your cube, then start the clock. The search is already running, so the answer
            is ready when time is.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * B3's answer to "which pair next".
 *
 * The confidence matters as much as the order. Pair order is genuinely a matter of taste much of
 * the time, and a ranker that presents a 34%/33%/33% call with the same certainty as a 90% one is
 * lying about what it knows.
 */
function NextPairAdvice({
  ranked,
  learned,
  crossFace,
  running,
  hasCube,
}: {
  ranked: readonly { slot: string; optimal: number; moves: string; confidence: number }[] | null;
  learned: boolean | null;
  crossFace: number | null;
  running: boolean;
  hasCube: boolean;
}) {
  if (!hasCube) {
    return <p className="text-sm text-neutral-600">Connect a cube, or use manual input.</p>;
  }
  if (running && ranked === null) return <p className="text-xs text-neutral-600">Thinking…</p>;
  if (ranked === null) return null;
  if (crossFace === null) {
    return (
      <p className="text-sm text-neutral-600">
        Build a cross first — which pair to do next only means something once one is up.
      </p>
    );
  }
  if (ranked.length === 0) {
    return <p className="text-sm text-neutral-600">F2L is done; nothing left to choose.</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-neutral-600">
        on the {colourOf(crossFace as Face).name} cross
      </p>
      <ul className="space-y-1">
        {ranked.map((entry, i) => (
          <li key={entry.slot} className="flex items-baseline gap-2">
            <span className={`w-8 text-xs ${i === 0 ? "text-emerald-400" : "text-neutral-500"}`}>
              {entry.slot}
            </span>
            <span className="w-10 text-right font-mono text-[11px] tabular-nums text-neutral-500">
              {entry.optimal}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
              <span
                className={`block h-full rounded-full ${i === 0 ? "bg-emerald-500" : "bg-neutral-600"}`}
                style={{ width: `${Math.max(2, 100 * entry.confidence)}%` }}
              />
            </span>
            <span className="w-9 text-right font-mono text-[11px] tabular-nums text-neutral-400">
              {`${(100 * entry.confidence).toFixed(0)}%`}
            </span>
            <span className="w-32 truncate font-mono text-[11px] text-neutral-600">
              {entry.moves}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-neutral-900 pt-1.5 text-[11px] leading-relaxed text-neutral-600">
        {learned
          ? "Ranked by a model trained on which pair pros actually did next — not by move count, which is the number in the second column."
          : "The model could not be loaded, so this is ordered by move count alone."}
      </p>
    </div>
  );
}

function PracticeControls({
  scramble,
  remaining,
  inspecting,
  revealed,
  onStart,
  onBegin,
  onReveal,
}: {
  scramble: string | null;
  remaining: number;
  inspecting: boolean;
  revealed: boolean;
  onStart: () => void;
  onBegin: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-2">
      {scramble ? (
        <p className="font-mono text-sm leading-relaxed text-neutral-100">{scramble}</p>
      ) : (
        <p className="text-sm text-neutral-500">
          Take a scramble, apply it, then plan the cross in fifteen seconds and see what was
          there.
        </p>
      )}

      {inspecting && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-neutral-500">inspecting</span>
            <span className="font-mono text-lg tabular-nums text-neutral-100">
              {(remaining / 1000).toFixed(1)}s
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className={`h-full ${remaining < 4000 ? "bg-amber-500" : "bg-sky-500"}`}
              style={{ width: `${(100 * remaining) / INSPECTION_MS}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onStart}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          {scramble ? "New scramble" : "Start"}
        </button>
        {scramble && !inspecting && !revealed && (
          <button
            type="button"
            onClick={onBegin}
            className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            Begin inspection
          </button>
        )}
        {inspecting && !revealed && (
          <button
            type="button"
            onClick={onReveal}
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Reveal now
          </button>
        )}
      </div>
    </div>
  );
}

function ColourRow({ plan }: { plan: ColourPlan }) {
  const colour = colourOf(plan.crossFace);
  const best = plan.cross[0];
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded border border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-neutral-900/60"
      >
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-neutral-700"
          style={{ backgroundColor: colour.hex }}
        />
        <span className="w-14 text-xs text-neutral-400">{colour.name}</span>
        <span className="font-mono text-xs tabular-nums text-neutral-300">
          {plan.crossLength} move{plan.crossLength === 1 ? "" : "s"}
        </span>
        {best && <Solution solution={best} compact />}
        <span className="ml-auto text-xs text-neutral-600">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-neutral-900 px-2 py-2">
          <Section title="cross" solutions={plan.cross} />
          <Section
            title={`cross + 1 pair${plan.xcrossLength > 0 ? ` — ${plan.xcrossLength} moves` : ""}`}
            solutions={plan.xcross}
          />
        </div>
      )}
    </li>
  );
}

function Section({ title, solutions }: { title: string; solutions: readonly PlannedSolution[] }) {
  if (solutions.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-600">{title}</h4>
      <ul className="space-y-1">
        {solutions.map((solution) => (
          <li key={`${solution.kind}-${solution.text}`}>
            <Solution solution={solution} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Solution({
  solution,
  compact = false,
}: {
  solution: PlannedSolution;
  compact?: boolean;
}) {
  const front = colourOf(solution.hold.front);

  if (compact) {
    return (
      <span className="truncate font-mono text-xs text-neutral-500">{solution.text}</span>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-mono text-xs text-neutral-200">{solution.text || "(nothing to do)"}</span>
      {solution.slot && <span className="text-[11px] text-emerald-500">slot {solution.slot}</span>}
      <span className="flex items-center gap-1 text-[11px] text-neutral-500">
        hold
        <span
          className="inline-block h-2.5 w-2.5 rounded-full border border-neutral-700"
          style={{ backgroundColor: front.hex }}
        />
        {front.name} in front
      </span>
      {solution.awkward.back > 0 && (
        <span
          className="text-[11px] text-amber-600"
          title="Pros turn the back face on 2.5% of cross moves; no grip avoids it here."
        >
          {solution.awkward.back}× back
        </span>
      )}
    </div>
  );
}
