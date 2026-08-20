/**
 * Build the derived corpus from the raw HTML cache.
 *
 * Pure local work — no network. Safe to re-run after any parser or normalization change,
 * which is the point of caching raw pages in the first place.
 *
 * Usage: npm run build-corpus -w @cubing-companion/corpus
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EmptyReconstructionError,
  ParseError,
  parseSolvePage,
  peekEvent,
} from "../src/parse.ts";
import { segmentSolve } from "../src/segment.ts";
import { summarize } from "../src/stats.ts";
import { Method, type Rejection, type SolveRecord } from "../src/types.ts";
import {
  CACHE_DIR,
  CORPUS_PATH,
  REJECTIONS_PATH,
  SUMMARY_PATH,
} from "../src/paths.ts";

const files = (await readdir(CACHE_DIR)).filter((f) => f.endsWith(".html"));
if (files.length === 0) {
  console.error(
    `no cached pages in ${CACHE_DIR}\nrun: npm run crawl -w @cubing-companion/corpus`,
  );
  process.exit(1);
}

console.log(`building corpus from ${files.length} cached pages\n`);

const records: SolveRecord[] = [];
const rejections: Rejection[] = [];
const unknownLabelCounts: Record<string, number> = {};

for (const file of files) {
  const id = Number(file.replace(".html", ""));
  const html = await readFile(join(CACHE_DIR, file), "utf8");

  // Scope guard first, per PLAN.md: events share one id space, and other puzzles do not
  // all carry an alg.cubing.net permalink. Checking the event up front keeps them out of
  // the "unparseable" bucket, where they would misrepresent the funnel.
  const event = peekEvent(html);
  if (event !== "3x3") {
    rejections.push({ id, reason: "not-3x3", detail: `event: ${event ?? "unknown"}` });
    continue;
  }

  let raw;
  try {
    raw = parseSolvePage(html, id);
  } catch (cause) {
    rejections.push({
      id,
      reason:
        cause instanceof EmptyReconstructionError
          ? "empty-reconstruction"
          : "unparseable-notation",
      detail: cause instanceof ParseError ? cause.message : String(cause),
    });
    continue;
  }

  const result = segmentSolve(raw);

  // Only count unrecognized labels on solves we actually want. A Roux solve's `CMLL` is
  // not a gap in CFOP normalization, and tallying it would bury the labels that are.
  if (result.record?.method === Method.CFOP) {
    for (const label of result.unknownLabels) {
      unknownLabelCounts[label] = (unknownLabelCounts[label] ?? 0) + 1;
    }
  }

  if (!result.record) {
    rejections.push({
      id,
      reason: result.error?.reason ?? "no-segments",
      detail: result.error?.detail ?? "unknown",
    });
    continue;
  }

  if (result.record.method !== Method.CFOP) {
    rejections.push({
      id,
      reason: "not-cfop",
      detail: `method: ${result.record.method}`,
    });
    continue;
  }

  records.push(result.record);
}

records.sort((a, b) => a.id - b.id);
rejections.sort((a, b) => a.id - b.id);

await writeFile(
  CORPUS_PATH,
  records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  "utf8",
);
await writeFile(
  REJECTIONS_PATH,
  rejections.map((r) => JSON.stringify(r)).join("\n") + "\n",
  "utf8",
);

const summary = summarize(records, unknownLabelCounts);
await writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

// The funnel, so it is obvious where solves are being lost.
const byReason: Record<string, number> = {};
for (const r of rejections) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;

console.log(`pages parsed:      ${files.length}`);
for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  rejected ${reason.padEnd(22)} ${count}`);
}
console.log(`accepted:          ${records.length}`);
console.log(`  by quality:      ${JSON.stringify(summary.byQuality)}`);
console.log(`\nunknown labels:    ${summary.unknownLabels.length} distinct`);
for (const [label, count] of summary.unknownLabels.slice(0, 15)) {
  console.log(`  ${String(count).padStart(4)}  ${label}`);
}
console.log(`\nwrote ${CORPUS_PATH}`);
console.log(`wrote ${REJECTIONS_PATH}`);
console.log(`wrote ${SUMMARY_PATH}`);
