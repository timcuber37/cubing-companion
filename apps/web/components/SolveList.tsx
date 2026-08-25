"use client";

import { useMemo } from "react";
import { segmentRecord, type SolveRecord } from "@cubing-companion/session";
import { PHASE_LABEL } from "./phaseLabels";

/**
 * Recorded solves, newest first, each broken into CFOP phases.
 *
 * The phase breakdown is what makes this A2's deliverable rather than a timer: segmentation
 * runs on read rather than being stored, so an improvement to the segmenter applies to every
 * solve already recorded.
 */
export function SolveList({
  solves,
  onDelete,
  onSelect,
}: {
  solves: SolveRecord[];
  onDelete: (id: string) => void;
  onSelect: (solve: SolveRecord) => void;
}) {
  return (
    <div className="rounded-md border border-neutral-800">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Solves
        </h2>
        <span className="text-xs text-neutral-600">{solves.length}</span>
      </div>

      {solves.length === 0 ? (
        <p className="px-3 py-4 text-sm text-neutral-600">
          Nothing recorded yet. Scramble the cube to match, then solve it.
        </p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-neutral-900 overflow-y-auto">
          {solves.map((solve) => (
            <SolveRow
              key={solve.id}
              solve={solve}
              onDelete={onDelete}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {solves.length > 0 && (
        <p className="border-t border-neutral-800 px-3 py-2 text-[11px] leading-relaxed text-neutral-600">
          Times run from the first move to the last — not a stackmat time. Open a solve to see
          the full breakdown, where the pro baselines are corrected for that difference.
        </p>
      )}
    </div>
  );
}

function SolveRow({
  solve,
  onDelete,
  onSelect,
}: {
  solve: SolveRecord;
  onDelete: (id: string) => void;
  onSelect: (solve: SolveRecord) => void;
}) {
  // Segmentation is derived on read; memoised so scrolling does not re-run it.
  const analysed = useMemo(() => {
    try {
      return segmentRecord(solve);
    } catch {
      return null;
    }
  }, [solve]);

  const spans = analysed?.segmentation.segmentation?.spans ?? [];
  const durations = analysed?.phaseDurations ?? [];

  return (
    <li
      className="cursor-pointer px-3 py-2 hover:bg-neutral-900/60"
      onClick={() => onSelect(solve)}
      title="Open the full analysis"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-lg tabular-nums text-neutral-100">
            {solve.durationMs === null
              ? "—"
              : (solve.durationMs / 1000).toFixed(2)}
          </span>
          <span className="text-xs text-neutral-500">
            {solve.moveCount} moves
            {solve.tps !== null && ` · ${solve.tps.toFixed(1)} tps`}
          </span>
          {solve.outcome === "discarded" && (
            <span className="text-xs text-amber-500">discarded</span>
          )}
          {!solve.scrambleMatched && (
            <span
              className="text-xs text-neutral-600"
              title="The cube did not match the displayed scramble; this solve was started from its actual position."
            >
              off-scramble
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(solve.id);
          }}
          className="text-xs text-neutral-600 hover:text-neutral-300"
          aria-label="Delete solve"
        >
          ×
        </button>
      </div>

      {spans.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {spans.map((span, i) => (
            <span
              key={span.phase}
              className="rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400"
              title={`${span.turns} turns, ${span.rotations} rotations${span.slot ? `, slot ${span.slot}` : ""}`}
            >
              <span className="text-neutral-500">{PHASE_LABEL[span.phase] ?? span.phase}</span>{" "}
              {durations[i] == null ? "—" : `${(durations[i]! / 1000).toFixed(2)}s`}
              <span className="text-neutral-600"> / {span.turns}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-amber-600">
          Could not segment: {analysed?.segmentation.failure ?? "unknown"}
        </p>
      )}
    </li>
  );
}
