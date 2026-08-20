/**
 * Fetch reco.nz solve pages into the local cache.
 *
 * Resumable — re-running skips anything already cached, so an interrupted crawl just
 * continues. See `src/fetch.ts` for the politeness rationale.
 *
 * Usage:
 *   npm run crawl -w @cubing-companion/corpus -- --from 1 --to 500
 *   npm run crawl -w @cubing-companion/corpus -- --from 1 --to 14500 --delay 2000
 */
import { crawl } from "../src/fetch.ts";
import { CACHE_DIR } from "../src/paths.ts";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const from = arg("from", 1);
const to = arg("to", 500);
const delayMs = arg("delay", 1500);

console.log(
  `crawling reco.nz solves ${from}..${to} into ${CACHE_DIR}\n` +
    `  ${delayMs}ms between requests (~${(1000 / delayMs).toFixed(2)} req/s), cached responses skipped\n`,
);

const started = Date.now();
let lastLog = 0;

const summary = await crawl({
  cacheDir: CACHE_DIR,
  from,
  to,
  delayMs,
  onProgress: ({ id, status, fetched, total }) => {
    const now = Date.now();
    if (status !== "cached" && now - lastLog > 5000) {
      lastLog = now;
      const done = id - from + 1;
      const rate = fetched / ((now - started) / 1000);
      const remaining = rate > 0 ? (total - done) / rate : 0;
      console.log(
        `  id ${id} (${done}/${total})  fetched=${fetched}  ` +
          `eta=${remaining > 0 ? `${Math.round(remaining / 60)}m` : "-"}`,
      );
    }
  },
});

console.log(
  `\ndone: ${summary.fetched} fetched, ${summary.cached} already cached, ` +
    `${summary.missing} missing (404), ${summary.failed} failed`,
);
if (summary.abortedAt !== null) {
  console.error(
    `\nABORTED at id ${summary.abortedAt} after repeated failures. ` +
      `Re-run to resume; nothing already cached will be refetched.`,
  );
  process.exitCode = 1;
}
