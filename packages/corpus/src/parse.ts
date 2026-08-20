/**
 * reco.nz solve page -> {@link RawSolve}.
 *
 * The pages are server-rendered PHP with no JSON anywhere, so this is regex over HTML.
 * That is normally a poor idea, but the markup here is hand-written, stable, and simple,
 * and the two fields that matter most come from the most reliable places on the page:
 *
 * - scramble and solution from the `alg.cubing.net` permalink, where both are already
 *   URL-encoded as single values rather than spread across markup;
 * - solver, time, and event from the `og:title` meta tag.
 *
 * Anything not found is `null` rather than a throw. A missing hardware string should not
 * cost us a solve.
 */
import type { RawSolve, SolveStats, StatGroup } from "./types.ts";

export class ParseError extends Error {
  override readonly name: string = "ParseError";
}

/**
 * The page exists and carries metadata, but has no reconstruction — `setup=&alg=` and an
 * empty reconstruction block. These are placeholder entries, common among early solve ids.
 * Distinguished from a parse failure so the rejection funnel separates "we could not read
 * this" from "there was nothing to read".
 */
export class EmptyReconstructionError extends ParseError {
  override readonly name = "EmptyReconstructionError";
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).trim();

/**
 * Clean a scramble or solution taken from the permalink's query string.
 *
 * Some pages double-encode: a trailing newline arrives as `%250A`, which one decode turns
 * into a literal `%0A` rather than a newline. Cube notation never legitimately contains
 * `%`, so a remaining escape is unambiguously an under-decoded value and it is safe to
 * decode again. Bounded to two extra passes so a pathological value cannot loop.
 *
 * Anything still containing `%` afterwards is malformed, and is deliberately left as-is:
 * notation parsing will reject the solve and it will appear in the rejections file. That
 * is much better than stripping the offending characters, which could quietly turn a
 * corrupt scramble into a different but well-formed one.
 */
function cleanAlgParam(value: string): string {
  let current = value;
  for (let pass = 0; pass < 2 && current.includes("%"); pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break; // malformed escape — leave it to fail loudly downstream
    }
    if (decoded === current) break;
    current = decoded;
  }
  return current.replace(/\r\n?/g, "\n").trim();
}

function parseNumber(text: string): number | null {
  const cleaned = text.replace("%", "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse the `solvestats` table.
 *
 * Columns are phase groups (Total, F2L, LL, Cross+1, OLS, PLL) and rows are metrics
 * (Time, Split, STM, STPS, ETM, ETPS). Both vary between pages — older solves publish
 * fewer groups — so this reads the header rather than assuming positions.
 */
export function parseStats(html: string): SolveStats | null {
  const table = html.match(/<table id=['"]solvestats['"]>([\s\S]*?)<\/table>/)?.[1];
  if (!table) return null;

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
  if (rows.length < 2) return null;

  const groups = [...rows[0]!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => stripTags(m[1]!))
    .filter((h) => h !== "");
  if (groups.length === 0) return null;

  const metrics = new Map<string, (number | null)[]>();
  for (const row of rows.slice(1)) {
    const label = stripTags(row.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? "");
    if (label === "") continue;
    const values = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      parseNumber(stripTags(m[1]!)),
    );
    metrics.set(label.toLowerCase(), values);
  }

  const stats: Record<string, StatGroup> = {};
  groups.forEach((group, index) => {
    const at = (metric: string) => metrics.get(metric)?.[index] ?? null;
    stats[group] = {
      time: at("time"),
      split: at("split"),
      stm: at("stm"),
      stps: at("stps"),
      etm: at("etm"),
      etps: at("etps"),
    };
  });
  return stats;
}

/**
 * Read just the event from a page, cheaply and without requiring a reconstruction.
 *
 * Exists so callers can apply the 3x3 scope guard *before* demanding an
 * `alg.cubing.net` permalink. Other puzzles do not all have one — Square-1 solves are
 * written in `(-3,5) / (3,0)` notation and link to cubedb.net instead — so checking the
 * permalink first would file them under "unparseable" rather than "not 3x3", which
 * misrepresents the rejection funnel.
 */
export function peekEvent(html: string): string | null {
  const title = decodeEntities(
    html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "",
  );
  return title.match(/^.*?\s+-\s+[\d.]+\s+(\S+)\s+solve\b/)?.[1] ?? null;
}

/**
 * Parse a solve page.
 *
 * @throws {ParseError} when the scramble/solution permalink is absent, which is the one
 * thing a 3x3 solve genuinely cannot do without.
 */
export function parseSolvePage(html: string, id: number): RawSolve {
  const permalink = html.match(/href="(https:\/\/alg\.cubing\.net\/\?[^"]+)"/)?.[1];
  if (!permalink) {
    throw new ParseError(`solve ${id}: no alg.cubing.net permalink`);
  }
  const params = new URL(decodeEntities(permalink)).searchParams;
  const rawScramble = params.get("setup");
  const rawSolution = params.get("alg");
  if (rawScramble === null || rawSolution === null) {
    throw new ParseError(`solve ${id}: permalink missing setup or alg`);
  }
  const scramble = cleanAlgParam(rawScramble);
  const solution = cleanAlgParam(rawSolution);
  if (scramble === "" || solution === "") {
    throw new EmptyReconstructionError(
      `solve ${id}: page has no reconstruction (empty setup or alg)`,
    );
  }

  // e.g. "Max Park - 3.13 3x3 solve - reco.nz"
  const title = decodeEntities(
    html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "",
  ).replace(/\s*-\s*reco\.nz\s*$/, "");
  const titleMatch = title.match(/^(.*?)\s+-\s+([\d.]+)\s+(\S+)\s+solve\s*$/);

  // e.g. "[WR] 2023-06-11 - Pride in Long Beach 2023 - reconstruction by BlueAcidball"
  const subtitle = html.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "";
  const subtitleText = stripTags(subtitle);

  return {
    id,
    url: `https://reco.nz/solve/${id}`,
    solver: titleMatch?.[1]?.trim() ?? stripTags(html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ""),
    solverSlug: html.match(/href="[^"]*\/solver\/([^"]+)"/)?.[1] ?? null,
    timeSeconds: titleMatch?.[2] ? Number(titleMatch[2]) : null,
    event: titleMatch?.[3] ?? null,
    date: subtitleText.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null,
    competition:
      subtitleText
        .match(/\d{4}-\d{2}-\d{2}\s*-\s*(.*?)\s*-\s*reconstruction by/)?.[1]
        ?.trim() ?? null,
    tags: [...subtitleText.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!),
    reconstructor:
      stripTags(subtitle.match(/reconstruction by\s*(<a[^>]*>[\s\S]*?<\/a>|[^<]*)/)?.[1] ?? "") ||
      null,
    reconstructorSlug: html.match(/href="[^"]*\/reconstructor\/([^"]+)"/)?.[1] ?? null,
    hardware:
      decodeEntities(html.match(/hardware:\s*([^<\n]+)/)?.[1] ?? "").trim() || null,
    scramble,
    solution,
    stats: parseStats(html),
  };
}
