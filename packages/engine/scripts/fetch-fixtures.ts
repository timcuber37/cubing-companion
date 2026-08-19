/**
 * One-off: build `test/fixtures/reconstructions.json` from a small sample of reco.nz
 * solves, so the engine is tested against real-world notation rather than only notation
 * we invented.
 *
 * The output is checked in; the test suite runs entirely offline. This script exists for
 * provenance and so the sample can be refreshed deliberately.
 *
 * Citizenship: reco.nz is a volunteer community project with no ads and no sponsorship.
 * This fetches a couple of dozen pages, one at a time, with a delay between them. The
 * bulk corpus crawl (B1) is a different matter and should start with a note to the
 * maintainer asking about an export.
 *
 * Run: npm run fetch-fixtures -w @cubing-companion/engine
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const USER_AGENT =
  "cubing-companion/0.0 (engine test fixtures; a few requests, rate-limited)";
const DELAY_MS = 1500;
const TARGET_COUNT = 20;

/** Solve ids to try, spread across the id range rather than clustered. */
const CANDIDATE_IDS = [
  9155, 6370, 11583, 1200, 2400, 3100, 3800, 4500, 5200, 5900,
  6600, 7300, 8000, 8700, 9400, 10100, 10800, 11000, 11200, 11400,
  2000, 2800, 4000, 4800, 5500, 6100, 7000, 7700, 8400, 9800,
];

export interface Fixture {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly attribution: string;
  readonly scramble: string;
  /** Solution with the reconstructor's `// phase` annotations preserved. */
  readonly solution: string;
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extract(html: string, id: number): Fixture | null {
  const link = html.match(/href="(https:\/\/alg\.cubing\.net\/\?[^"]+)"/);
  if (!link?.[1]) return null;

  const url = new URL(decodeEntities(link[1]));
  const scramble = url.searchParams.get("setup");
  const solution = url.searchParams.get("alg");
  if (!scramble || !solution) return null;

  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "";
  const description =
    html.match(/<meta property="og:description"\s+content="([^"]*)"/)?.[1] ?? "";

  // Scope guard: 3x3 only. OH and big-cube pages share the same layout.
  if (!/\b3x3 solve\b/.test(title)) return null;

  return {
    id,
    url: `https://reco.nz/solve/${id}`,
    title: decodeEntities(title).replace(/ - reco\.nz$/, ""),
    attribution: decodeEntities(description),
    scramble: scramble.trim(),
    solution: solution.trim(),
  };
}

const fixtures: Fixture[] = [];
for (const id of CANDIDATE_IDS) {
  if (fixtures.length >= TARGET_COUNT) break;
  const response = await fetch(`https://reco.nz/solve/${id}`, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!response.ok) {
    console.warn(`skip ${id}: HTTP ${response.status}`);
    await sleep(DELAY_MS);
    continue;
  }
  const fixture = extract(await response.text(), id);
  if (fixture) {
    fixtures.push(fixture);
    console.log(`ok   ${id}: ${fixture.title}`);
  } else {
    console.warn(`skip ${id}: not a parseable 3x3 solve`);
  }
  await sleep(DELAY_MS);
}

const target = fileURLToPath(
  new URL("../test/fixtures/reconstructions.json", import.meta.url),
);
await writeFile(
  target,
  `${JSON.stringify(
    {
      _source: "https://reco.nz — solve reconstructions by the cubing community.",
      _note:
        "Test fixtures only. Each entry credits its solver and reconstructor via `title` and `attribution`.",
      _fetched: new Date().toISOString().slice(0, 10),
      fixtures,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`\nwrote ${fixtures.length} fixtures to ${target}`);
