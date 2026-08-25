import { Phase } from "@cubing-companion/analysis";

/** Short names, shared so a phase is never called two different things in two places. */
export const PHASE_LABEL: Record<string, string> = {
  [Phase.Cross]: "cross",
  [Phase.F2L1]: "F2L1",
  [Phase.F2L2]: "F2L2",
  [Phase.F2L3]: "F2L3",
  [Phase.F2L4]: "F2L4",
  [Phase.OLL]: "OLL",
  [Phase.PLL]: "PLL",
  [Phase.AUF]: "AUF",
};

/**
 * Band colours for the timeline.
 *
 * One hue per stage rather than eight unrelated colours: the cross reads as its own thing, the
 * four pairs as a family that gets lighter as the solve goes on, and the last layer as a third.
 * The point is to see the shape of the solve at a glance, not to decode a legend.
 */
export const PHASE_TINT: Record<string, string> = {
  [Phase.Cross]: "bg-sky-400/80",
  [Phase.F2L1]: "bg-emerald-500/80",
  [Phase.F2L2]: "bg-emerald-400/80",
  [Phase.F2L3]: "bg-emerald-300/80",
  [Phase.F2L4]: "bg-emerald-200/80",
  [Phase.OLL]: "bg-amber-400/80",
  [Phase.PLL]: "bg-orange-400/80",
  [Phase.AUF]: "bg-neutral-500/80",
};
