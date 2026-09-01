"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyMoves,
  fromFacelets,
  parseMoves,
  serializeMove,
  type CubeState,
  type Face,
  type Move,
} from "@cubing-companion/engine";
import { observesRotations, segmentRecord, type SolveRecord } from "@cubing-companion/session";
import { GEOMETRY, slotName } from "@cubing-companion/analysis";
import {
  frameFor,
  renameMoves,
  rotationPuttingColourDown,
  slotColours,
  type Orientation,
} from "@cubing-companion/planner";
import {
  computeMetrics,
  scoreSolve,
  solveStartIndex,
  type Rated,
  type SolveMetrics,
} from "@cubing-companion/metrics";
import { TwistyPlayer, type TwistyHandle } from "./TwistyPlayer";
import { Timeline } from "./Timeline";
import { PHASE_LABEL } from "./phaseLabels";
import { DiffPanel } from "./DiffPanel";

/** Spacing used to lay out a solve that arrived without a usable clock. */
const FALLBACK_GAP_MS = 120;
const SPEEDS = [0.25, 0.5, 1] as const;

/**
 * One solve, opened up: replay, timeline, per-phase metrics, and how it compares.
 *
 * A2 could already tell you a solve took 9.4 seconds and where the moves went. This is the part
 * that answers "and was that any good", which is the whole of A3.
 */
export function SolveDetail({
  solve,
  onClose,
  recentDurationsMs = [],
}: {
  solve: SolveRecord;
  onClose: () => void;
  /** Your other recent solves, so speed can be rated against you rather than against pros. */
  recentDurationsMs?: readonly number[];
}) {
  const analysis = useMemo(() => analyse(solve), [solve]);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [branch, setBranch] = useState<Branch | null>(null);

  /**
   * Whichever line is on the cube — your solve, or an alternative someone asked to see.
   *
   * Playback and scrubbing read from this rather than from the solve, which is the whole of what
   * branch playback needed: the transport, the timeline and the cube plumbing never learn that
   * branches exist.
   */
  const line = branch ?? analysis;

  const playerRef = useRef<TwistyHandle>(null);
  const positionRef = useRef(0);
  positionRef.current = position;

  // Scrubbing is a jump to a precomputed position rather than an animation. That keeps the cube
  // exactly in step with the timeline at any speed: a real solve turns faster than the player
  // animates, so animating each move would fall progressively behind the clock it is meant to
  // be showing.
  const viewFrame = analysis?.viewFrame ?? null;
  useEffect(() => {
    if (!line) return;
    const state = line.states[Math.min(position, line.states.length - 1)]!;
    // Cross-colour down, applied only as the cube is drawn — never to the states themselves.
    playerRef.current?.setState(
      viewFrame && viewFrame.rotation.length > 0
        ? applyMoves(state, viewFrame.rotation)
        : state,
    );
  }, [line, position, viewFrame]);

  useEffect(() => {
    if (!playing || !line) return;
    const { offsets } = line;
    // Anchored once, at the moment play begins, so a dropped frame does not lose time. Advancing
    // the position must not re-anchor, or playback runs slow by the per-move overshoot.
    const startedAt = performance.now();
    const from = offsets[positionRef.current] ?? 0;
    let frame = 0;

    const tick = () => {
      const target = from + (performance.now() - startedAt) * speed;
      let next = positionRef.current;
      while (next < offsets.length - 1 && offsets[next + 1]! <= target) next++;
      if (next !== positionRef.current) {
        positionRef.current = next;
        setPosition(next);
      }
      if (next >= offsets.length - 1) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [line, playing, speed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seek = (index: number) => {
    setPlaying(false);
    setPosition(index);
  };

  /** Swap the cube onto an alternative line, parked at the moment it diverges. */
  const playBranch = (at: number, moves: string, label: string) => {
    if (!analysis) return;
    setBranch(buildBranch(analysis, at, moves, label));
    setPlaying(false);
    setPosition(at);
  };

  const returnToSolve = () => {
    const at = branch?.at ?? position;
    setBranch(null);
    setPlaying(false);
    setPosition(at);
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-neutral-950/90 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Solve analysis"
    >
      <div className="mx-auto max-w-5xl space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-2xl tabular-nums text-neutral-100">
              {solve.durationMs === null ? "—" : (solve.durationMs / 1000).toFixed(2)}
            </span>
            <span className="text-sm text-neutral-500">
              {solve.moveCount} moves
              {solve.tps !== null && ` · ${solve.tps.toFixed(1)} tps`}
            </span>
            <span className="text-xs text-neutral-600">
              {new Date(solve.startedAt).toLocaleString()}
            </span>
            {/* The scramble this was solved from, under the time. Without it a solve in the
                history is just a number: you cannot try it again, or see what you were given. */}
            {solve.scrambleText && (
              <p className="w-full font-mono text-xs leading-relaxed text-neutral-400">
                {solve.scrambleText}
                {!solve.scrambleMatched && (
                  <span
                    className="ml-2 text-amber-600"
                    title="The cube did not match this scramble when the solve began, so it is shown for reference rather than as what you actually solved."
                  >
                    not the position solved
                  </span>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Close
          </button>
        </header>

        {!analysis || !line ? (
          <p className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
            This solve could not be segmented, so there is nothing to compare. Its moves are
            still stored.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <section className="space-y-3">
              <TwistyPlayer ref={playerRef} />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => seek(Math.max(0, position - 1))}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                  aria-label="Previous move"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Replaying from the end should start over rather than do nothing.
                    if (position >= line.offsets.length - 1) setPosition(0);
                    setPlaying((was) => !was);
                  }}
                  className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
                >
                  {playing ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={() => seek(Math.min(line.offsets.length - 1, position + 1))}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                  aria-label="Next move"
                >
                  ▶
                </button>

                <div className="ml-auto flex gap-1">
                  {SPEEDS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setSpeed(option)}
                      className={`rounded px-1.5 py-1 text-xs ${
                        speed === option
                          ? "bg-neutral-700 text-neutral-100"
                          : "text-neutral-500 hover:text-neutral-300"
                      }`}
                    >
                      {option}×
                    </button>
                  ))}
                </div>
              </div>

              <Timeline
                offsets={line.offsets}
                // A branch has no phases of its own and never had pauses: nobody turned it.
                phases={branch ? [] : analysis.metrics.phases}
                pauses={branch ? [] : analysis.metrics.pauses}
                position={position}
                onSeek={seek}
              />

              <p className="font-mono text-xs leading-relaxed text-neutral-500">
                {line.moveText.map((text, i) => (
                  <span
                    key={i}
                    className={
                      i < position
                        ? "text-neutral-300"
                        : i === position
                          ? "bg-sky-900/70 text-sky-200"
                          : ""
                    }
                  >
                    {text}{" "}
                  </span>
                ))}
              </p>
              {!analysis.timed && (
                <p className="text-[11px] text-amber-600">
                  This solve has no usable per-move clock, so the timeline is laid out evenly and
                  no time is scored.
                </p>
              )}
            </section>

            <section className="space-y-4">
              <ScorePanel
                metrics={analysis.metrics}
                solve={solve}
                recentDurationsMs={recentDurationsMs}
              />
              <DiffPanel
                startFacelets={solve.startFacelets}
                solution={solve.solution}
                onPlayBranch={playBranch}
                onReturn={returnToSolve}
                branchLabel={branch?.label ?? null}
              />
              <PhaseTable analysis={analysis} onSeek={seek} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function ScorePanel({
  metrics,
  solve,
  recentDurationsMs,
}: {
  metrics: SolveMetrics;
  solve: SolveRecord;
  recentDurationsMs: readonly number[];
}) {
  const score = useMemo(
    () =>
      scoreSolve(metrics, {
        rotationsObserved: observesRotations(solve.source),
        recentDurationsMs,
      }),
    [metrics, solve.source, recentDurationsMs],
  );

  return (
    <div className="rounded-md border border-neutral-800 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          How this solve rates
        </h3>
        {score.rating !== null && (
          <span className="font-mono tabular-nums text-neutral-100">
            <span className="text-2xl">{score.rating.toFixed(1)}</span>
            <span className="text-sm text-neutral-500"> / 10</span>
          </span>
        )}
      </div>

      {/* The composite is only ever shown with the parts it averaged. A single number tells a
          solver they were a 63 and gives them nothing to do about it. */}
      <dl className="mt-2 space-y-1.5">
        {score.components.map(({ label, rated }) => (
          <div key={label} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-2">
            <dt className="whitespace-nowrap text-xs text-neutral-400">
              {label}
              <span
                className="ml-1 text-[10px] text-neutral-600"
                title={
                  rated.reference === "you"
                    ? `Against your own recent solves — median ${(rated.distribution.median / 1000).toFixed(2)}s over ${rated.distribution.n} of them.`
                    : `Against the pro corpus — median ${rated.distribution.median}.`
                }
              >
                {rated.reference === "you" ? "vs you" : "vs pros"}
              </span>
            </dt>
            <dd>
              <ScoreBar rated={rated} />
            </dd>
            <dd className="text-right font-mono text-xs tabular-nums text-neutral-300">
              {rated.rating.toFixed(1)}
            </dd>
          </div>
        ))}
      </dl>

      {score.omitted.map((entry) => (
        <p key={entry.label} className="mt-1.5 text-[11px] leading-relaxed text-amber-600/90">
          {entry.label} not scored — {entry.reason}.
        </p>
      ))}

      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-neutral-500">
        <span>
          fluidity{" "}
          <span className="text-neutral-300">
            {metrics.fluidity === null ? "—" : `${(100 * metrics.fluidity).toFixed(0)}%`}
          </span>{" "}
          {score.fluidityBand && `(${score.fluidityBand})`}
        </span>
        <span>
          {metrics.pauses.length} pause{metrics.pauses.length === 1 ? "" : "s"}
          {metrics.longestPause &&
            `, longest ${(metrics.longestPause.durationMs / 1000).toFixed(2)}s`}
        </span>
      </div>

      <p className="mt-2 border-t border-neutral-900 pt-2 text-[11px] leading-relaxed text-neutral-600">
        Move counts are rated against {score.baselineNote.corpusSolves.toLocaleString()}{" "}
        world-class reconstructions, on a scale where{" "}
        <strong className="text-neutral-400">the median one of those is 8</strong> and their
        slowest tenth is 6 — being anywhere in that band is a very good day. Speed is rated
        against <strong className="text-neutral-400">your own recent solves</strong> instead,
        where 5 is a typical day for you: pros are far enough ahead that scoring your time
        against theirs would read zero however much you improved. Fluidity and pauses are
        measured but not scored — reconstructions carry no per-move timing.
      </p>
    </div>
  );
}

function ScoreBar({ rated }: { rated: Rated }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
      title={`corpus median ${rated.distribution.median}, you ${rated.value.toFixed(2)}`}
    >
      <div
        className={`h-full rounded-full ${rated.score >= 50 ? "bg-emerald-500" : "bg-sky-600"}`}
        style={{ width: `${Math.max(2, rated.score)}%` }}
      />
    </div>
  );
}

function PhaseTable({
  analysis,
  onSeek,
}: {
  analysis: NonNullable<ReturnType<typeof analyse>>;
  onSeek: (index: number) => void;
}) {
  const score = useMemo(() => scoreSolve(analysis.metrics), [analysis.metrics]);
  const windowFor = (phases: readonly string[]) =>
    score.windows.find((w) => phases.length === 0 || w.window === phases[0]);

  return (
    <div className="rounded-md border border-neutral-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-neutral-800 text-left text-neutral-500">
            <th className="px-2 py-1.5 font-medium">phase</th>
            <th className="px-2 py-1.5 text-right font-medium">time</th>
            <th className="px-2 py-1.5 text-right font-medium">turns</th>
            <th className="px-2 py-1.5 text-right font-medium">tps</th>
            <th className="px-2 py-1.5 text-right font-medium" title="Time before the phase's first move — finding the piece rather than turning it.">
              recog
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Out of 10 against the pro corpus; 5.0 is the median world-class solve.">
              vs pros
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-900">
          {analysis.metrics.phases.map((phase) => {
            const rated = score.phases.find((p) => p.phase === phase.phase)?.turns ?? null;
            return (
              <tr
                key={phase.phase}
                onClick={() => onSeek(phase.start)}
                className="cursor-pointer hover:bg-neutral-900/60"
                title="Jump to the start of this phase"
              >
                <td className="px-2 py-1.5 text-neutral-300">
                  {PHASE_LABEL[phase.phase] ?? phase.phase}
                  {phase.slot && (
                    <span className="text-neutral-600">
                      {" "}
                      {pairLabel(analysis.crossFace, phase.slot)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-300">
                  {phase.durationMs === null ? "—" : `${(phase.durationMs / 1000).toFixed(2)}`}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-400">
                  {phase.turns}
                  {phase.rotations > 0 && (
                    <span className="text-neutral-600" title={`${phase.rotations} rotations`}>
                      +{phase.rotations}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-400">
                  {phase.tps === null ? "—" : phase.tps.toFixed(1)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-500">
                  {phase.recognitionMs === null
                    ? "—"
                    : `${(phase.recognitionMs / 1000).toFixed(2)}`}
                </td>
                <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                  {rated === null ? (
                    <span className="text-neutral-700">—</span>
                  ) : (
                    <span className={rated.score >= 50 ? "text-emerald-400" : "text-neutral-400"}>
                      {rated.rating.toFixed(1)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {score.windows.length > 0 && (
        <div className="border-t border-neutral-800 px-2 py-2">
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-neutral-600">
            Timed against the corpus
          </h4>
          <ul className="space-y-0.5">
            {score.windows.map((window) => (
              <li key={window.window} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-neutral-400">
                  {window.window}
                  {window.time?.overheadCorrected && (
                    <span
                      className="ml-1 text-neutral-600"
                      title="The pro baseline for this window had estimated stackmat grab/drop time removed, so it can be compared with a smart-cube clock. An estimate, not a measurement."
                    >
                      ✽
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums text-neutral-500">
                  {window.seconds.toFixed(2)}s
                  {window.time && (
                    <span
                      className={`ml-2 ${window.time.score >= 50 ? "text-emerald-400" : "text-neutral-400"}`}
                    >
                      {window.time.rating.toFixed(1)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-600">
            Cross, and pairs 1–3 individually, have no time baseline — reco.nz never published
            splits that fine. ✽ marks a window whose baseline was corrected for timer overhead.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * An alternative continuation, built onto the front of your own solve.
 *
 * It keeps the real prefix so the branch has context — you see the solve arrive at the decision
 * and then go the other way — and appends the alternative at an even tempo, because nobody
 * actually turned it and inventing timings for it would be a lie the timeline would then draw.
 */
export interface Branch {
  readonly at: number;
  readonly label: string;
  readonly states: readonly CubeState[];
  readonly offsets: readonly number[];
  readonly moveText: readonly string[];
  readonly timed: boolean;
}

function buildBranch(
  analysis: NonNullable<ReturnType<typeof analyse>>,
  at: number,
  moves: string,
  label: string,
): Branch | null {
  let parsed: Move[];
  try {
    parsed = parseMoves(moves);
  } catch {
    return null;
  }

  const states = [...analysis.states.slice(0, at + 1)];
  for (const move of parsed) {
    states.push(applyMoves(states[states.length - 1]!, [move]));
  }

  const offsets = [...analysis.offsets.slice(0, at + 1)];
  for (let i = 0; i < parsed.length; i++) {
    offsets.push(offsets[offsets.length - 1]! + FALLBACK_GAP_MS);
  }

  return {
    at,
    label,
    states,
    offsets,
    moveText: [
      ...analysis.moveText.slice(0, at),
      // Renamed under the same view as the solve's own text, so the branch reads in the frame
      // the viewer is looking at.
      ...parsed.map((move) =>
        serializeMove(renameMoves([move], analysis.viewFrame)[0]!),
      ),
    ],
    timed: false,
  };
}

/**
 * A span's slot, named by its side colours instead of its frame-relative position.
 *
 * Span names are piece names in the normalised frame — a white-cross solve calls its first pair
 * "UF", which describes where the edge lives, not anything the solver was looking at. The
 * colours of a pair survive every rotation of the frame, which is why solvers name pairs that
 * way themselves.
 */
function pairLabel(crossFace: Face, spanSlot: string): string {
  const slot = GEOMETRY[crossFace]?.slots.find((s) => slotName(s) === spanSlot);
  return slot ? slotColours(slot) : spanSlot;
}

/** Everything derived from the stored record, computed once per solve. */
function analyse(solve: SolveRecord) {
  let states: CubeState[];
  let moveText: string[];
  let metrics: SolveMetrics;
  // Declared out here because the offsets below need it: the timeline has to know which moves
  // were inspection rotations, and that is a property of the moves, not of the timestamps.
  let moves: Move[];

  let crossFace: Face;
  let viewFrame: Orientation;

  try {
    moves = parseMoves(solve.solution);
    const segmented = segmentRecord(solve).segmentation.segmentation;
    const spans = segmented?.spans ?? [];
    if (!segmented || spans.length === 0) return null;
    crossFace = segmented.crossFace;

    metrics = computeMetrics(spans, solve.moveTimestamps);
    states = [fromFacelets(solve.startFacelets)];
    for (const move of moves) {
      states.push(applyMoves(states[states.length - 1]!, [move]));
    }

    // The replay is viewed the way a solver holds the cube: cross colour down. One **fixed**
    // rotation, chosen at the first real turn — per-state compensation would silently swallow
    // the user's own mid-solve rotations, which are worth seeing. Display-only: `states` stay
    // raw, so branch moves keep applying in the frame they were computed for, and the rotation
    // is added at the moment the cube is drawn.
    viewFrame = frameFor(
      rotationPuttingColourDown(
        states[Math.min(solveStartIndex(moves), states.length - 1)]!.centers,
        crossFace,
      ),
    );
    // The text must name the faces the viewer sees turn, or a white-cross solve viewed
    // cross-down would say U while the bottom face visibly moves.
    moveText = moves.map((move) => serializeMove(renameMoves([move], viewFrame)[0]!));
  } catch {
    return null;
  }

  // `offsets[i]` is the moment the i-th move landed, relative to the **first real turn** — the
  // rotations before it are inspection and cost the solve nothing, so the timeline must not draw
  // them as time spent or the cross band would start with a gap nobody solved through.
  const solveStart = solveStartIndex(moves);
  const base = solve.moveTimestamps.slice(solveStart).find((t) => t !== null) ?? null;
  const timed = base !== null;
  const offsets: number[] = [0];
  for (let i = 0; i < moveText.length; i++) {
    const stamp = solve.moveTimestamps[i] ?? null;
    const previous = offsets[i]!;
    offsets.push(
      stamp === null || base === null
        ? previous + FALLBACK_GAP_MS
        : // Clamp: a retimed stream can hand back a stamp that moves backwards.
          Math.max(previous, stamp - base),
    );
  }

  return { states, offsets, moveText, metrics, timed, crossFace, viewFrame };
}
