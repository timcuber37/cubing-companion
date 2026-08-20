import { describe, expect, it } from "vitest";
import { classifyMethod, normalizeLabel } from "../src/labels.ts";
import { Method, Phase } from "../src/types.ts";

const phasesOf = (label: string) => [...normalizeLabel(label).phases];

describe("label normalization", () => {
  it("handles the core CFOP vocabulary", () => {
    expect(phasesOf("inspection")).toEqual([Phase.Inspection]);
    expect(phasesOf("cross")).toEqual([Phase.Cross]);
    expect(phasesOf("1st pair")).toEqual([Phase.F2L1]);
    expect(phasesOf("4th pair")).toEqual([Phase.F2L4]);
    expect(phasesOf("OLL")).toEqual([Phase.OLL]);
    expect(phasesOf("PLL")).toEqual([Phase.PLL]);
    expect(phasesOf("AUF")).toEqual([Phase.AUF]);
  });

  it("is case- and spacing-insensitive", () => {
    for (const written of ["xcross", "Xcross", "X-Cross", "x cross", " xcross "]) {
      expect(phasesOf(written)).toEqual([Phase.Cross, Phase.F2L1]);
    }
  });

  it("folds one F2L slot into the cross per extra x", () => {
    expect(phasesOf("xcross")).toEqual([Phase.Cross, Phase.F2L1]);
    expect(phasesOf("xxcross")).toEqual([Phase.Cross, Phase.F2L1, Phase.F2L2]);
    expect(phasesOf("xxxcross")).toEqual([
      Phase.Cross,
      Phase.F2L1,
      Phase.F2L2,
      Phase.F2L3,
    ]);
    expect(phasesOf("pseudo xcross")).toEqual([Phase.Cross, Phase.F2L1]);
  });

  it("marks multi-phase labels as merged", () => {
    expect(normalizeLabel("xcross").merged).toBe(true);
    expect(normalizeLabel("cross").merged).toBe(false);
    expect(normalizeLabel("1st pair").merged).toBe(false);
  });

  it("splits merged labels it has no whole-label rule for", () => {
    expect(normalizeLabel("3rd/4th pairs").phases).toEqual(
      expect.arrayContaining([Phase.F2L3, Phase.F2L4]),
    );
    expect(normalizeLabel("1st & 2nd & 3rd pairs").phases).toEqual(
      expect.arrayContaining([Phase.F2L1, Phase.F2L2, Phase.F2L3]),
    );
    expect(normalizeLabel("4th pair / VLS").phases).toEqual(
      expect.arrayContaining([Phase.F2L4, Phase.OLL]),
    );
    expect(normalizeLabel("2nd pair/finish cross").phases).toEqual(
      expect.arrayContaining([Phase.Cross, Phase.F2L2]),
    );
  });

  it("treats parenthesized qualifiers as merges", () => {
    // Found in the corpus: `4th pair (EO)`, `4th pair (OLS)`. Same meaning as the
    // slash-separated forms.
    expect(normalizeLabel("4th pair (EO)").phases).toEqual(
      expect.arrayContaining([Phase.F2L4, Phase.EO]),
    );
    expect(normalizeLabel("4th pair (OLS)").phases).toEqual(
      expect.arrayContaining([Phase.F2L4, Phase.OLL]),
    );
    expect(normalizeLabel("4th pair (EO)").merged).toBe(true);
  });

  it("still matches atomic names that contain parentheses", () => {
    // `OLL(CP)` must not be split into `OLL` and `CP` — it is one algorithm set, and
    // splitting it would wrongly add a PLL phase.
    expect(phasesOf("OLL(CP)")).toEqual([Phase.OLL]);
    expect(normalizeLabel("OLL(CP)").merged).toBe(false);
  });

  it("handles the last-slot-plus-orientation systems", () => {
    for (const system of ["VLS", "WVLS", "OLS", "CLS", "ZBLS", "HLS", "EOLS"]) {
      expect(phasesOf(system), system).toEqual([Phase.F2L4, Phase.OLL]);
    }
    expect(phasesOf("OCLL")).toEqual([Phase.OLL]);
    expect(normalizeLabel("4th pair / WVLS").phases).toEqual(
      expect.arrayContaining([Phase.F2L4, Phase.OLL]),
    );
  });

  it("ignores qualifiers that comment on a phase without adding one", () => {
    // `OLL (cancelled)` is still just OLL, and must not be marked merged — a merge would
    // exclude the solve from per-phase distributions for no reason.
    const cancelled = normalizeLabel("OLL (cancelled)");
    expect(cancelled.phases).toEqual([Phase.OLL]);
    expect(cancelled.merged).toBe(false);
    expect(cancelled.recognized).toBe(true);

    expect(normalizeLabel("PLL (skip)").phases).toEqual([Phase.PLL]);
    expect(normalizeLabel("3rd pair (forced)").merged).toBe(false);
  });

  it("treats a pseudo prefix as describing how, not which", () => {
    expect(phasesOf("pseudo 3rd pair")).toEqual([Phase.F2L3]);
    expect(phasesOf("pseudo xcross")).toEqual([Phase.Cross, Phase.F2L1]);
    // `psuedo` is a common misspelling in the corpus.
    expect(phasesOf("psuedo cross")).toEqual([Phase.Cross]);
    expect(phasesOf("psuedo xcross")).toEqual([Phase.Cross, Phase.F2L1]);
  });

  it("recognizes colour-named crosses", () => {
    // Colour-neutral solvers' reconstructors name the cross colour. Missing these made
    // the method classifier discard hundreds of genuine CFOP solves as Unknown.
    for (const colour of ["white", "yellow", "red", "orange", "blue", "green"]) {
      expect(phasesOf(`${colour} cross`), colour).toEqual([Phase.Cross]);
    }
    expect(phasesOf("yellow xcross")).toEqual([Phase.Cross, Phase.F2L1]);
  });

  it("accepts prefixes that describe how the cross was built", () => {
    expect(phasesOf("eoxcross")).toEqual([Phase.Cross, Phase.F2L1]);
    expect(phasesOf("EOXcross")).toEqual([Phase.Cross, Phase.F2L1]);
    expect(phasesOf("eocross")).toEqual([Phase.Cross]);
    expect(phasesOf("bencross")).toEqual([Phase.Cross]);
    expect(phasesOf("benxcross")).toEqual([Phase.Cross, Phase.F2L1]);
    expect(phasesOf("partial cross")).toEqual([Phase.Cross]);
  });

  it("handles adjacent pairs written without a separator", () => {
    expect(normalizeLabel("3rd 4th pairs").phases).toEqual(
      expect.arrayContaining([Phase.F2L3, Phase.F2L4]),
    );
    expect(normalizeLabel("1st 2nd pairs").phases).toEqual(
      expect.arrayContaining([Phase.F2L1, Phase.F2L2]),
    );
    expect(normalizeLabel("last 2 pairs").phases).toEqual(
      expect.arrayContaining([Phase.F2L3, Phase.F2L4]),
    );
    expect(normalizeLabel("4th pair VLS").phases).toEqual(
      expect.arrayContaining([Phase.F2L4, Phase.OLL]),
    );
  });

  it("recognizes two-look last-layer systems as last layer, not OLL or PLL", () => {
    // CLL and ELL split the last layer by piece type. Counting either as OLL or PLL
    // would contaminate those baselines.
    for (const system of ["2GLL", "CLL", "ELL", "ZBLL", "1LLL"]) {
      expect(phasesOf(system), system).toEqual([Phase.LastLayer]);
    }
    expect(phasesOf("(C)OLL")).toEqual([Phase.OLL]);
    expect(phasesOf("LSLL")).toEqual([Phase.F2L4, Phase.LastLayer]);
  });

  it("strips a stray leading comment marker", () => {
    expect(phasesOf("// 4th pair")).toEqual([Phase.F2L4]);
    expect(phasesOf("/ EPLL")).toEqual([Phase.PLL]);
  });

  it("recognizes cross repair phrasings", () => {
    expect(phasesOf("fix cross")).toEqual([Phase.Cross]);
    expect(phasesOf("finish cross")).toEqual([Phase.Cross]);
    expect(normalizeLabel("2nd pair+fix cross").phases).toEqual(
      expect.arrayContaining([Phase.Cross, Phase.F2L2]),
    );
  });

  it("keeps standalone EO distinct from OLL", () => {
    // EO+ZBLL solves orient edges as their own step. Counting that as OLL would
    // contaminate the OLL baseline with a much cheaper step.
    expect(phasesOf("EO")).toEqual([Phase.EO]);
    expect(phasesOf("OLL")).toEqual([Phase.OLL]);
  });

  it("treats one-look last layer as neither OLL nor PLL", () => {
    expect(phasesOf("ZBLL")).toEqual([Phase.LastLayer]);
    expect(phasesOf("1LLL")).toEqual([Phase.LastLayer]);
  });

  it("maps OLL variants that still solve all of orientation", () => {
    expect(phasesOf("OLL(CP)")).toEqual([Phase.OLL]);
    expect(phasesOf("OLLCP")).toEqual([Phase.OLL]);
    expect(phasesOf("COLL")).toEqual([Phase.OLL]);
  });

  it("reports unrecognized labels rather than silently dropping them", () => {
    const result = normalizeLabel("something nobody writes");
    expect(result.recognized).toBe(false);
    expect(result.phases).toEqual([Phase.Unknown]);
  });
});

describe("method classification", () => {
  it("recognizes CFOP from its shape", () => {
    expect(
      classifyMethod(["inspection", "cross", "1st pair", "2nd pair", "OLL", "PLL"]),
    ).toBe(Method.CFOP);
    // An xcross start still reads as CFOP.
    expect(classifyMethod(["xcross", "2nd pair", "3rd pair", "OLL", "PLL"])).toBe(
      Method.CFOP,
    );
  });

  it("rejects Roux on a single marker", () => {
    expect(classifyMethod(["FB", "SS", "SP", "CMLL", "EOLR"])).toBe(Method.Roux);
    // Even mixed in with CFOP-looking labels, CMLL settles it.
    expect(classifyMethod(["cross", "1st pair", "CMLL"])).toBe(Method.Roux);
  });

  it("recognizes ZZ and Petrus", () => {
    expect(classifyMethod(["EOLine", "1st pair", "OLL", "PLL"])).toBe(Method.ZZ);
    expect(classifyMethod(["2x2x2", "2x2x3", "OLL", "PLL"])).toBe(Method.Petrus);
  });

  it("does not assume CFOP when the shape is absent", () => {
    expect(classifyMethod(["inspection", "solve"])).toBe(Method.Unknown);
    expect(classifyMethod([])).toBe(Method.Unknown);
    // Cross and last layer but no F2L slot is not enough.
    expect(classifyMethod(["cross", "OLL", "PLL"])).toBe(Method.Unknown);
    // A fragment: cross and one pair, going nowhere.
    expect(classifyMethod(["cross", "1st pair"])).toBe(Method.Unknown);
  });

  it("accepts a solve whose last layer skipped", () => {
    // Ends at AUF with no OLL or PLL. Requiring a last-layer step discarded these.
    expect(
      classifyMethod([
        "inspection", "cross", "1st pair", "2nd pair", "3rd pair", "4th pair", "AUF",
      ]),
    ).toBe(Method.CFOP);
  });

  it("accepts a solve whose cross was never labelled", () => {
    // All four numbered slots plus a last layer is unmistakably CFOP; no other method
    // labels its steps this way.
    expect(
      classifyMethod([
        "inspection", "1st pair", "2nd pair", "3rd pair", "4th pair", "OLL", "PLL",
      ]),
    ).toBe(Method.CFOP);
  });

  it("accepts colour-named and one-look-last-layer solves", () => {
    expect(
      classifyMethod(["yellow cross", "1st pair", "2nd pair", "3rd pair", "4th pair", "2GLL"]),
    ).toBe(Method.CFOP);
    expect(
      classifyMethod(["cross", "1st pair", "2nd pair", "3rd pair", "4th pair", "CLL", "ELL"]),
    ).toBe(Method.CFOP);
  });
});
