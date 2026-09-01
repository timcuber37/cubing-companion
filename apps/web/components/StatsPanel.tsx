"use client";

import { useMemo } from "react";
import { AVERAGE_SIZES, sessionStats, type SolveRecord } from "@cubing-companion/session";

const seconds = (ms: number | null) => (ms === null ? "—" : (ms / 1000).toFixed(2));

/**
 * The numbers a speedcubing timer shows.
 *
 * Deliberately the standard set rather than anything this project invented: best single, the
 * rolling averages of 5 and 12, and their personal bests. They are what a cuber already reads
 * their progress in, and inventing a house metric here would mean nobody could compare a session
 * with the rest of their cubing life.
 */
export function StatsPanel({ solves }: { solves: readonly SolveRecord[] }) {
  const stats = useMemo(() => sessionStats(solves), [solves]);

  if (stats.count === 0) {
    return null;
  }

  return (
    <div className="rounded-md border border-neutral-800">
      <div className="flex items-baseline justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Session
        </h2>
        <span className="text-xs text-neutral-600">
          {stats.count} solve{stats.count === 1 ? "" : "s"}
          {stats.excluded > 0 && (
            <span
              className="ml-1 text-neutral-700"
              title="Discarded attempts, and solves with no usable clock, are left out of every figure here."
            >
              ({stats.excluded} not counted)
            </span>
          )}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2 sm:grid-cols-4">
        <Stat label="best" value={seconds(stats.best)} accent />
        <Stat label="mean" value={seconds(stats.mean)} />
        {AVERAGE_SIZES.map((size) => (
          <Stat
            key={size}
            label={`ao${size}`}
            value={seconds(stats.averages[size].current)}
            // The personal best sits under the current one, which is how a timer shows it and
            // what makes the current number mean anything.
            below={
              stats.averages[size].best === null
                ? undefined
                : `pb ${seconds(stats.averages[size].best)}`
            }
            accent={
              stats.averages[size].current !== null &&
              stats.averages[size].current === stats.averages[size].best
            }
          />
        ))}
      </dl>

      <p className="border-t border-neutral-800 px-3 py-1.5 text-[11px] leading-relaxed text-neutral-600">
        An average of {AVERAGE_SIZES.join(" or ")} strikes out the best and worst solve and means
        the rest, as the WCA defines it — so one lucky solve cannot flatter a session, and one
        disaster cannot ruin it. The mean beside it does both.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  below,
  accent = false,
}: {
  label: string;
  value: string;
  below?: string | undefined;
  accent?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-neutral-600">{label}</dt>
      <dd
        className={`font-mono text-lg tabular-nums ${accent ? "text-emerald-400" : "text-neutral-100"}`}
      >
        {value}
      </dd>
      {below && <dd className="font-mono text-[11px] tabular-nums text-neutral-500">{below}</dd>}
    </div>
  );
}
