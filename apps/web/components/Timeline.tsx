"use client";

import { useCallback, useRef } from "react";
import type { PhaseMetrics, Pause } from "@cubing-companion/metrics";
import { PHASE_LABEL, PHASE_TINT } from "./phaseLabels";

/**
 * A solve as a strip of time: phase bands, pauses drawn where they happened, and a handle.
 *
 * Laid out by **time rather than by move**, which is the whole point. A move-indexed strip
 * spreads the solve evenly and hides the thing worth seeing; on a time axis a two-second hunt
 * for the last pair is a two-second block of dead space, exactly as it felt.
 */
export function Timeline({
  offsets,
  phases,
  pauses,
  position,
  onSeek,
}: {
  /** Milliseconds from the first move to the point where `i` moves have been applied. */
  offsets: readonly number[];
  phases: readonly PhaseMetrics[];
  pauses: readonly Pause[];
  position: number;
  onSeek: (index: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const total = offsets[offsets.length - 1] ?? 0;
  const pct = (ms: number) => (total <= 0 ? 0 : (100 * ms) / total);

  /** Seek to whichever move boundary is nearest the point clicked. */
  const seekTo = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || total <= 0) return;
      const { left, width } = bar.getBoundingClientRect();
      const target = ((clientX - left) / width) * total;

      let nearest = 0;
      for (let i = 1; i < offsets.length; i++) {
        if (Math.abs(offsets[i]! - target) < Math.abs(offsets[nearest]! - target)) nearest = i;
      }
      onSeek(nearest);
    },
    [offsets, onSeek, total],
  );

  return (
    <div className="space-y-1">
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label="Solve timeline"
        aria-valuemin={0}
        aria-valuemax={offsets.length - 1}
        aria-valuenow={position}
        className="relative h-9 w-full cursor-pointer select-none rounded border border-neutral-800 bg-neutral-950"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekTo(event.clientX);
        }}
        onPointerMove={(event) => {
          // Only while dragging: `buttons` is 0 for a plain hover.
          if (event.buttons > 0) seekTo(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onSeek(Math.max(0, position - 1));
          if (event.key === "ArrowRight") onSeek(Math.min(offsets.length - 1, position + 1));
        }}
      >
        {phases.map((phase) => {
          const from = offsets[phase.start] ?? 0;
          const to = offsets[phase.end] ?? from;
          const width = pct(to - from);
          if (width <= 0) return null;
          return (
            <div
              key={phase.phase}
              className={`absolute inset-y-0 ${PHASE_TINT[phase.phase]}`}
              style={{ left: `${pct(from)}%`, width: `${width}%` }}
              title={`${PHASE_LABEL[phase.phase]} — ${((to - from) / 1000).toFixed(2)}s, ${phase.turns} turns`}
            >
              {/* Only label a band wide enough to read; the tooltip covers the rest. */}
              {width > 7 && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-medium text-neutral-950/70">
                  {PHASE_LABEL[phase.phase]}
                </span>
              )}
            </div>
          );
        })}

        {pauses.map((pause) => (
          <div
            key={pause.moveIndex}
            className="pointer-events-none absolute inset-y-0 border-x border-rose-400/70 bg-rose-500/40"
            style={{
              left: `${pct(pause.offsetMs)}%`,
              width: `${Math.max(0.4, pct(pause.durationMs))}%`,
            }}
            title={`Paused ${(pause.durationMs / 1000).toFixed(2)}s before move ${pause.moveIndex + 1}`}
          />
        ))}

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-neutral-100"
          style={{ left: `${pct(offsets[position] ?? 0)}%` }}
        />
      </div>

      <div className="flex justify-between text-[10px] text-neutral-600">
        <span>0.00s</span>
        <span className="text-rose-400/80">
          {pauses.length === 0
            ? "no pauses"
            : `${pauses.length} pause${pauses.length === 1 ? "" : "s"} in red`}
        </span>
        <span>{(total / 1000).toFixed(2)}s</span>
      </div>
    </div>
  );
}
