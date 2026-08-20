/**
 * Parser tests.
 *
 * The fixtures here are synthetic pages modelled on reco.nz's markup rather than copies of
 * real ones. That keeps their data out of the repo and makes each test state plainly which
 * structural feature it exercises.
 */
import { describe, expect, it } from "vitest";
import {
  ParseError,
  parseSolvePage,
  parseStats,
  peekEvent,
} from "../src/parse.ts";

interface PageOptions {
  setup?: string;
  alg?: string;
  title?: string;
  subtitle?: string;
  hardware?: string;
  stats?: string;
}

function page(options: PageOptions = {}): string {
  const {
    setup = "D2+F2+D%27+R2+U%27+L2",
    alg = "x2+%2F%2F+inspection%0AR+U+R%27+%2F%2F+cross",
    title = "Max Park - 3.13 3x3 solve - reco.nz",
    subtitle = `[WR] 2023-06-11 - Pride in Long Beach 2023 - reconstruction by <a href="../reconstructor/BlueAcidball" id="reconstructor-link">BlueAcidball</a>`,
    hardware = "X-Man Tornado V3",
    stats = `<table id='solvestats'>
      <tr><th></th><th>Total</th><th>F2L</th><th>LL</th></tr>
      <tr><th>Time</th><td>3.13</td><td>2.37</td><td>0.76</td></tr>
      <tr><th>Split</th><td>100%</td><td>75.7%</td><td>24.3%</td></tr>
      <tr><th>STM</th><td>33</td><td>24</td><td>9</td></tr>
      <tr><th>STPS</th><td>10.54</td><td>10.13</td><td>11.84</td></tr>
      <tr><th>ETM</th><td>33</td><td>24</td><td>9</td></tr>
      <tr><th>ETPS</th><td>10.54</td><td>10.13</td><td>11.84</td></tr>
    </table>`,
  } = options;

  return `<!DOCTYPE html><html><head>
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="33 STM - 10.54 TPS - reconstruction by BlueAcidball" />
  </head><body>
    <div class="container">
      <h1><a href="../solver/Max_Park" id="solver-link">Max Park</a> - 3.13 3x3 solve</h1>
      <h3>${subtitle}</h3>
      <div id="reconstruction">moves rendered here</div>
      view at <a href="https://alg.cubing.net/?setup=${setup}&amp;alg=${alg}">alg.cubing.net</a>
      ${stats}
      hardware: ${hardware}
    </div>
  </body></html>`;
}

describe("solve page parsing", () => {
  it("extracts the core fields", () => {
    const solve = parseSolvePage(page(), 9155);
    expect(solve.id).toBe(9155);
    expect(solve.url).toBe("https://reco.nz/solve/9155");
    expect(solve.solver).toBe("Max Park");
    expect(solve.solverSlug).toBe("Max_Park");
    expect(solve.timeSeconds).toBe(3.13);
    expect(solve.event).toBe("3x3");
    expect(solve.date).toBe("2023-06-11");
    expect(solve.competition).toBe("Pride in Long Beach 2023");
    expect(solve.tags).toEqual(["WR"]);
    expect(solve.reconstructor).toBe("BlueAcidball");
    expect(solve.reconstructorSlug).toBe("BlueAcidball");
    expect(solve.hardware).toBe("X-Man Tornado V3");
  });

  it("decodes scramble and solution from the permalink", () => {
    const solve = parseSolvePage(page(), 1);
    expect(solve.scramble).toBe("D2 F2 D' R2 U' L2");
    expect(solve.solution).toBe("x2 // inspection\nR U R' // cross");
  });

  it("recovers double-encoded values", () => {
    // Some pages encode a trailing newline as %250A, which one decode leaves as a literal
    // "%0A". Cube notation never contains "%", so a remaining escape is unambiguous.
    const solve = parseSolvePage(page({ setup: "R+U+R%27%250A" }), 1);
    expect(solve.scramble).toBe("R U R'");
  });

  it("leaves genuinely malformed values alone so they fail loudly downstream", () => {
    // Stripping the bad escape could turn a corrupt scramble into a different but
    // well-formed one, which would then verify against the wrong solve. Better to let
    // notation parsing reject it and have it show up in the rejections file.
    const solve = parseSolvePage(page({ setup: "R+U+%ZZ+R%27" }), 1);
    expect(solve.scramble).toContain("%ZZ");
  });

  it("distinguishes events, since they share one id space", () => {
    expect(parseSolvePage(page({ title: "X - 5.72 OH solve - reco.nz" }), 1).event).toBe("OH");
    expect(parseSolvePage(page({ title: "X - 99.06 7x7 solve - reco.nz" }), 1).event).toBe("7x7");
    expect(parseSolvePage(page({ title: "X - 3.13 3x3 solve - reco.nz" }), 1).event).toBe("3x3");
  });

  it("reads the event without needing a reconstruction", () => {
    // Square-1 solves are written as `(-3,5) / (3,0)` and link to cubedb.net, not
    // alg.cubing.net. peekEvent lets the 3x3 guard run before the permalink is demanded,
    // so they are rejected as not-3x3 rather than as unparseable.
    const sq1 = `<html><head>
      <meta property="og:title" content="Jackey Zheng - 4.95 SQ1 solve - reco.nz" />
      </head><body><div id="reconstruction">(-3,5) / (3,0) / // CS</div>
      <a href="https://cubedb.net/?puzzle=SQ1">cubedb</a></body></html>`;
    expect(peekEvent(sq1)).toBe("SQ1");
    expect(() => parseSolvePage(sq1, 7005)).toThrow(ParseError);

    expect(peekEvent(page())).toBe("3x3");
    expect(peekEvent("<html></html>")).toBeNull();
  });

  it("survives missing optional fields", () => {
    const solve = parseSolvePage(
      page({ subtitle: "reconstruction by Anon", hardware: "", stats: "" }),
      1,
    );
    expect(solve.date).toBeNull();
    expect(solve.competition).toBeNull();
    expect(solve.tags).toEqual([]);
    expect(solve.stats).toBeNull();
    // ...but the parts that matter are still there.
    expect(solve.scramble).not.toBe("");
    expect(solve.solution).not.toBe("");
  });

  it("throws only when the permalink is missing or empty", () => {
    expect(() => parseSolvePage("<html><body>nothing</body></html>", 1)).toThrow(
      ParseError,
    );
    expect(() => parseSolvePage(page({ setup: "" }), 1)).toThrow(ParseError);
  });
});

describe("stats table parsing", () => {
  it("reads groups from the header rather than assuming positions", () => {
    const stats = parseStats(page())!;
    expect(Object.keys(stats)).toEqual(["Total", "F2L", "LL"]);
    expect(stats.Total).toEqual({
      time: 3.13,
      split: 100,
      stm: 33,
      stps: 10.54,
      etm: 33,
      etps: 10.54,
    });
    expect(stats.LL?.time).toBe(0.76);
    expect(stats.F2L?.stm).toBe(24);
  });

  it("adapts to pages publishing a different set of groups", () => {
    const stats = parseStats(
      page({
        stats: `<table id='solvestats'>
          <tr><th></th><th>Total</th><th>Cross+1</th><th>OLS</th><th>PLL</th></tr>
          <tr><th>Time</th><td>3.13</td><td>1.27</td><td>1.27</td><td>0.16</td></tr>
        </table>`,
      }),
    )!;
    expect(Object.keys(stats)).toEqual(["Total", "Cross+1", "OLS", "PLL"]);
    expect(stats["Cross+1"]?.time).toBe(1.27);
    // Metrics absent from the table come back null, not zero.
    expect(stats["Cross+1"]?.stm).toBeNull();
  });

  it("returns null when there is no table", () => {
    expect(parseStats("<html></html>")).toBeNull();
  });
});
