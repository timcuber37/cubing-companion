"use client";

import { useEffect } from "react";
import type { CrossDiff, PairDiff } from "../workers/planner.worker";
import { usePlanner } from "./usePlanner";

/**
 * What a top solver would likely have done, decision by decision.
 *
 * Two kinds of feedback, kept visibly apart because they carry different weight. **Execution** is
 * a fact — you spent nine moves where six would do, and no model was consulted. **Choice** is a
 * prediction from a ranker that agrees with a real pro 69.6% of the time, which is a good ranker
 * and a poor oracle. So the choice half never says "you should have": it shows the whole
 * distribution with your pick marked, and words its preference according to how sure it is.
 */
export function DiffPanel({
  startFacelets,
  solution,
  onPlayBranch,
  onReturn,
  branchLabel,
}: {
  startFacelets: string;
  solution: string;
  onPlayBranch: (at: number, moves: string, label: string) => void;
  onReturn: () => void;
  branchLabel: string | null;
}) {
  const { diff, running, error, diffSolve } = usePlanner();

  useEffect(() => {
    diffSolve({ startFacelets, solution });
  }, [diffSolve, startFacelets, solution]);

  if (error) {
    return <p className="text-xs text-red-400">Could not compare this solve: {error}</p>;
  }
  if (!diff) {
    return (
      <p className="text-xs text-neutral-600">
        {running ? "Comparing against the model…" : "…"}
      </p>
    );
  }
  if (diff.failure) {
    return <p className="text-sm text-neutral-500">{diff.failure}</p>;
  }

  const matched = diff.pairs.filter((pair) => pair.yours === pair.theirs).length;

  return (
    <div className="rounded-md border border-neutral-800">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          What a top solver would do
        </h3>
        {diff.pairs.length > 0 && (
          <span className="text-[11px] text-neutral-600">
            {matched} of {diff.pairs.length} matched
          </span>
        )}
      </div>

      <div className="space-y-3 px-3 py-2">
        {branchLabel && (
          <div className="flex items-center justify-between rounded border border-sky-900/70 bg-sky-950/40 px-2 py-1">
            <span className="text-[11px] text-sky-300">
              showing {branchLabel} — not what you did
            </span>
            <button
              type="button"
              onClick={onReturn}
              className="rounded border border-sky-800 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-900/50"
            >
              Back to your solve
            </button>
          </div>
        )}

        {diff.cross && <CrossRow cross={diff.cross} onPlayBranch={onPlayBranch} />}

        {diff.pairs.map((pair) => (
          <PairRow key={pair.step} pair={pair} onPlayBranch={onPlayBranch} />
        ))}

        <p className="border-t border-neutral-900 pt-2 text-[11px] leading-relaxed text-neutral-600">
          {diff.learned
            ? "Move counts come from an exhaustive search and are exact. Which pair a solver would pick is a prediction — the model agrees with a real pro about 70% of the time, so the percentages are how often it expects each choice, not a verdict."
            : "The model could not be loaded, so only the move counts are shown. Those come from an exhaustive search and are exact."}
        </p>
      </div>
    </div>
  );
}

function CrossRow({
  cross,
  onPlayBranch,
}: {
  cross: CrossDiff;
  onPlayBranch: (at: number, moves: string, label: string) => void;
}) {
  const excess = cross.playedTurns - cross.optimalTurns;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="w-12 text-xs text-neutral-400">cross</span>
        <span className="font-mono text-xs tabular-nums text-neutral-300">
          {cross.playedTurns} moves
        </span>
        {excess > 0 ? (
          <span className="text-[11px] text-amber-500">
            {excess} more than the {cross.optimalTurns} available
          </span>
        ) : (
          <span className="text-[11px] text-emerald-500">optimal</span>
        )}
      </div>
      {cross.best && excess > 0 && (
        <div className="flex flex-wrap items-baseline gap-2 pl-14">
          <span className="font-mono text-[11px] text-neutral-400">{cross.best}</span>
          <span className="text-[11px] text-neutral-600">({cross.hold})</span>
          <button
            type="button"
            onClick={() => onPlayBranch(cross.at, cross.branch, "the shorter cross")}
            className="text-[11px] text-sky-400 hover:text-sky-300"
          >
            play it
          </button>
        </div>
      )}
    </div>
  );
}

function PairRow({
  pair,
  onPlayBranch,
}: {
  pair: PairDiff;
  onPlayBranch: (at: number, moves: string, label: string) => void;
}) {
  const agreed = pair.yours === pair.theirs;
  const excess = pair.playedTurns - pair.optimalTurns;

  return (
    <div className="space-y-1 border-t border-neutral-900 pt-2">
      <div className="flex items-baseline gap-2">
        <span className="w-12 text-xs text-neutral-400">pair {pair.step + 1}</span>
        <span className="text-xs text-neutral-300">you did {pair.yours}</span>
        {agreed ? (
          <span className="text-[11px] text-emerald-500">✓ the likely choice</span>
        ) : (
          <span className="text-[11px] text-amber-500">
            a top solver {pair.wording} {pair.theirs}
          </span>
        )}
        {excess > 0 && (
          <span className="ml-auto text-[11px] text-neutral-500">
            {pair.playedTurns} moves, {pair.optimalTurns} was available
          </span>
        )}
      </div>

      {pair.options.length > 0 && pair.options[0]!.confidence > 0 && (
        <ul className="space-y-0.5 pl-14">
          {pair.options.map((option) => (
            <li key={option.slot} className="flex items-center gap-2">
              <span
                className={`w-7 text-[11px] ${option.mine ? "text-neutral-100" : "text-neutral-500"}`}
              >
                {option.slot}
              </span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-800">
                <span
                  className={`block h-full rounded-full ${option.mine ? "bg-neutral-300" : "bg-emerald-600"}`}
                  style={{ width: `${Math.max(2, 100 * option.confidence)}%` }}
                />
              </span>
              <span className="w-8 text-right font-mono text-[11px] tabular-nums text-neutral-500">
                {(100 * option.confidence).toFixed(0)}%
              </span>
              <span className="w-14 font-mono text-[11px] tabular-nums text-neutral-600">
                {option.optimal} moves
              </span>
              {option.mine && <span className="text-[11px] text-neutral-500">← you</span>}
            </li>
          ))}
        </ul>
      )}

      {pair.reasons.length > 0 && (
        <ul className="space-y-0.5 pl-14">
          {pair.reasons.map((reason) => (
            <li key={reason} className="text-[11px] leading-relaxed text-neutral-400">
              — {reason}
            </li>
          ))}
        </ul>
      )}

      {!agreed && pair.branch && (
        <div className="pl-14">
          <button
            type="button"
            onClick={() => onPlayBranch(pair.at, pair.branch, `${pair.theirs} instead`)}
            className="text-[11px] text-sky-400 hover:text-sky-300"
          >
            play {pair.theirs} instead
          </button>
        </div>
      )}
    </div>
  );
}
