/**
 * Phase-label normalization and method classification.
 *
 * Reconstructors write labels freehand, so the vocabulary is wide and inconsistent:
 * `xcross`, `Xcross`, `pseudo xcross`, `OLL(CP)`, `3rd/4th pairs`, `2nd pair/finish cross`.
 * A first sample of 20 solves produced 28 distinct labels.
 *
 * Two rules govern this module:
 *
 * 1. A label may map to *several* phases. An `xcross` is cross plus first pair; a
 *    `3rd/4th pairs` block covers two slots. Those solves are still useful for
 *    whole-solve statistics but cannot contribute to per-phase distributions, so the
 *    merge is recorded rather than flattened away.
 * 2. Unknown labels are reported, never silently dropped. Quietly discarding an
 *    unrecognized label would bias the distributions in a way nothing downstream could
 *    detect.
 */
import { F2L_PHASES, Phase, Method } from "./types.ts";

export interface NormalizedLabel {
  readonly phases: readonly Phase[];
  readonly merged: boolean;
  readonly recognized: boolean;
}

/** Labels that identify a non-CFOP method. Presence of any of these settles the question. */
const METHOD_MARKERS: readonly (readonly [RegExp, Method])[] = [
  [/^(fb|first block|sb|second block|ss|sp|cmll|lse|eolr[a-z]*|4[abc]|nmcll)$/i, Method.Roux],
  [/^(eoline|eo line|zzf2l|zz\b.*)$/i, Method.ZZ],
  [/^(2x2x2|2x2x3|petrus\b.*)$/i, Method.Petrus],
];

/** Whole-label patterns, most specific first. Order matters: `xxcross` before `xcross`. */
const WHOLE_LABEL: readonly (readonly [RegExp, readonly Phase[]])[] = [
  [/^inspection$/i, [Phase.Inspection]],

  // Cross variants. Each extra `x` folds in one more F2L slot.
  // `psuedo` is a common misspelling and appears in the corpus often enough to matter.
  // Prefixes describe *how* the cross was built, not which phase it is: `eo` (edges
  // oriented alongside), `pseudo`/`psuedo` (offset by a D move, fixed later), `ben`
  // (deliberately incomplete, likewise fixed later).
  [/^(eo|ps[eu]{2}do|ben)?[\s-]*x{3}cross$/i, [Phase.Cross, Phase.F2L1, Phase.F2L2, Phase.F2L3]],
  [/^(eo|ps[eu]{2}do|ben)?[\s-]*x{2}cross$/i, [Phase.Cross, Phase.F2L1, Phase.F2L2]],
  [/^(eo|ps[eu]{2}do|ben)?[\s-]*x[\s-]?cross$/i, [Phase.Cross, Phase.F2L1]],
  [/^cross\s*\+\s*1$/i, [Phase.Cross, Phase.F2L1]],
  [
    /^(eo|xe|ps[eu]{2}do|ben|part?ial|3\/4)?[\s-]*cross$/i,
    [Phase.Cross],
  ],
  [/^(finish(ing)?|fix(ing)?|rest of|complete)\s+(the\s+)?cross$/i, [Phase.Cross]],
  // Colour-neutral solvers' reconstructors often name the cross colour instead of just
  // writing "cross". Without this, those solves have no recognized cross and the method
  // classifier discards them as non-CFOP.
  [
    /^(white|yellow|red|orange|blue|green)\s+cross$/i,
    [Phase.Cross],
  ],
  [
    /^(white|yellow|red|orange|blue|green)\s+x[\s-]?cross$/i,
    [Phase.Cross, Phase.F2L1],
  ],

  // F2L slots, written many ways.
  // A `pseudo` prefix describes how the pair was solved, not which pair it was.
  [/^(pseudo\s+)?(1st|first|1)\s*(pair|slot)s?$/i, [Phase.F2L1]],
  [/^(pseudo\s+)?(2nd|second|2)\s*(pair|slot)s?$/i, [Phase.F2L2]],
  [/^(pseudo\s+)?(3rd|third|3)\s*(pair|slot)s?$/i, [Phase.F2L3]],
  [/^(pseudo\s+)?(4th|fourth|4|last)\s*(pair|slot)s?$/i, [Phase.F2L4]],
  [/^pair\s*1$/i, [Phase.F2L1]],
  [/^pair\s*2$/i, [Phase.F2L2]],
  [/^pair\s*3$/i, [Phase.F2L3]],
  [/^pair\s*4$/i, [Phase.F2L4]],
  [/^f2l$/i, [Phase.F2L1, Phase.F2L2, Phase.F2L3, Phase.F2L4]],

  // Adjacent pairs written without a separator: `3rd 4th pairs`, `1st 2nd pairs`.
  [/^(1st|first)\s+(2nd|second)\s*(pair|slot)s?$/i, [Phase.F2L1, Phase.F2L2]],
  [/^(2nd|second)\s+(3rd|third)\s*(pair|slot)s?$/i, [Phase.F2L2, Phase.F2L3]],
  [/^(3rd|third)\s+(4th|fourth)\s*(pair|slot)s?$/i, [Phase.F2L3, Phase.F2L4]],
  [/^last\s*2\s*(pair|slot)s?$/i, [Phase.F2L3, Phase.F2L4]],

  // Bare ordinals appear inside merged labels such as `1st & 2nd & 3rd pairs`.
  [/^(1st|first)$/i, [Phase.F2L1]],
  [/^(2nd|second)$/i, [Phase.F2L2]],
  [/^(3rd|third)$/i, [Phase.F2L3]],
  [/^(4th|fourth)$/i, [Phase.F2L4]],

  // Standalone edge orientation, as in EO + ZBLL. Not OLL — see Phase.EO.
  [/^(eo|edge orientation|eo\s*step)$/i, [Phase.EO]],

  // Last layer. One-look and two-look systems that are neither OLL nor PLL alone must not
  // be counted as either. `cll`/`ell` split the last layer by piece type rather than by
  // orientation then permutation, so each is a last-layer step in its own right.
  [/^(zbll|1lll|2gll|ll|cll|ell|coll\+epll)$/i, [Phase.LastLayer]],
  [/^lsll$/i, [Phase.F2L4, Phase.LastLayer]],
  [/^(oll|ollcp|oll\s*\(?cp\)?|\(c\)oll|coll|ocll|wv|winter variation)$/i, [Phase.OLL]],
  // Last-slot-plus-orientation systems: one block solving the fourth pair and OLL
  // together. Named `<something>LS` by convention, but listed explicitly rather than
  // pattern-matched, since a loose `.*ls` rule would swallow unrelated labels.
  [/^(vls|wvls|svls|vhls|rls|ols|cls|zbls|hls|els|eols|sv|summer variation)$/i, [Phase.F2L4, Phase.OLL]],
  // The same systems written after a pair with only a space between, e.g. `4th pair VLS`.
  // Separator-joined forms (`4th pair / VLS`) are handled by the split path instead.
  [
    /^(1st|2nd|3rd|4th|last)\s*(pair|slot)s?\s+(vls|wvls|svls|vhls|rls|ols|cls|zbls|hls|els|eols)$/i,
    [Phase.F2L4, Phase.OLL],
  ],
  [/^(pll|epll|cpll|ep|cp|pll\s*skip)$/i, [Phase.PLL]],
  [/^auf$/i, [Phase.AUF]],
];

/** Separators used when a reconstructor merges phases into one annotated block. */
const SEPARATORS = /\s*(?:\/|&|\+|,|\band\b)\s*/i;

/**
 * Qualifiers that comment on a phase without adding one.
 *
 * `OLL (cancelled)` is still just OLL — the note says the algorithm cancelled into the
 * next step. Treating these as unrecognized would flood the unknown-label report with
 * commentary, and treating them as phases would wrongly mark the label merged.
 */
const IGNORABLE_QUALIFIER =
  /^(cancell?ed|cancel|skip(ped)?|forced|lucky|inserted|predicted|planned|partial|misc|nothing|none|free)$/i;

function matchWhole(label: string): readonly Phase[] | null {
  for (const [pattern, phases] of WHOLE_LABEL) {
    if (pattern.test(label)) return phases;
  }
  return null;
}

/** Detect a non-CFOP method marker in a single label. */
export function methodMarker(label: string): Method | null {
  const cleaned = label.trim();
  for (const [pattern, method] of METHOD_MARKERS) {
    if (pattern.test(cleaned)) return method;
  }
  return null;
}

/**
 * Normalize one label to the phases it covers.
 *
 * Tries the whole label first, then splits on `/`, `&`, `+`, `,` and unions the parts —
 * which is what makes `4th pair / VLS` and `1st & 2nd & 3rd pairs` resolve correctly
 * without enumerating every combination reconstructors invent.
 */
export function normalizeLabel(rawLabel: string): NormalizedLabel {
  const label = rawLabel
    .trim()
    // A stray leading `//` or `/` survives when a reconstructor double-comments a line.
    .replace(/^[/\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;]+$/, "")
    .trim();
  if (label === "") {
    return { phases: [Phase.Unknown], merged: false, recognized: false };
  }

  const whole = matchWhole(label);
  if (whole) {
    return { phases: whole, merged: whole.length > 1, recognized: true };
  }

  // Parenthesized qualifiers behave as merges: `4th pair (EO)` is the fourth pair and an
  // EO step in one block, exactly like `4th pair / EO`. Done after the whole-label pass so
  // atomic names containing parens, such as `OLL(CP)`, are matched intact first.
  const parts = label
    .replace(/[()]/g, "/")
    .split(SEPARATORS)
    .filter((p) => p.trim() !== "");
  if (parts.length > 1) {
    const collected = new Set<Phase>();
    let allRecognized = true;
    for (const part of parts) {
      const trimmed = part.trim();
      if (IGNORABLE_QUALIFIER.test(trimmed)) continue;
      const phases = matchWhole(trimmed);
      if (phases) for (const phase of phases) collected.add(phase);
      else allRecognized = false;
    }
    if (collected.size > 0) {
      return {
        phases: [...collected],
        // Merged means "covers more than one phase", which a qualifier does not make it.
        merged: collected.size > 1,
        recognized: allRecognized,
      };
    }
  }

  return { phases: [Phase.Unknown], merged: false, recognized: false };
}

/**
 * Classify the solving method from a solve's labels.
 *
 * A single Roux or ZZ marker settles it — those labels have no CFOP meaning. Those markers
 * are trustworthy in practice: across the full corpus, Roux and ZZ solves fire several
 * markers each and none is also cross-and-pairs shaped.
 *
 * Otherwise a solve counts as CFOP on its shape: a cross plus either a recognized
 * last-layer step, or all four F2L slots. The second clause matters — a solve whose last
 * layer skipped, or whose reconstruction simply ends at `AUF`, is still plainly CFOP, and
 * requiring a last-layer step discarded hundreds of real solves.
 */
export function classifyMethod(rawLabels: readonly string[]): Method {
  for (const label of rawLabels) {
    const marker = methodMarker(label);
    if (marker) return marker;
  }

  const phases = new Set<Phase>();
  for (const label of rawLabels) {
    for (const phase of normalizeLabel(label).phases) phases.add(phase);
  }

  const hasCross = phases.has(Phase.Cross);
  const hasLastLayer =
    phases.has(Phase.OLL) || phases.has(Phase.PLL) || phases.has(Phase.LastLayer);
  const slots = F2L_PHASES.filter((p) => phases.has(p)).length;
  const hasAllSlots = slots === F2L_PHASES.length;

  // All four numbered slots plus either end of the solve is unmistakably CFOP: no other
  // method labels its steps `1st`..`4th pair`. This admits solves whose last layer
  // skipped and solves whose cross the reconstructor simply never labelled.
  if (hasAllSlots && (hasCross || hasLastLayer)) return Method.CFOP;
  // Otherwise require the full shape, so a partial reconstruction is not mistaken for one.
  if (hasCross && hasLastLayer && slots > 0) return Method.CFOP;
  return Method.Unknown;
}
