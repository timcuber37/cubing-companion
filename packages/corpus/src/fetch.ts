/**
 * Polite, resumable crawler for reco.nz solve pages.
 *
 * Citizenship notes, since they are the reason several of these choices look conservative:
 *
 * - reco.nz is a volunteer community project with no ads, no sponsorship, and no contact
 *   channel anywhere on the site (the listed "dev team" is four cats). There is no
 *   robots.txt and no stated terms, so there is nothing prohibiting this — but there is
 *   also nobody to ask, so politeness has to be demonstrated by behaviour.
 * - One request at a time, with a delay between them. The default works out near
 *   0.6 requests/second, which is far below what a static PHP site handles.
 * - **Every response is cached to disk and never refetched.** This is the important one:
 *   parser and normalization changes cost zero additional requests, so the site is hit
 *   once per solve, ever.
 * - 404s are cached too, so gaps are not retried on resume.
 * - Backs off on 429/5xx and aborts entirely after repeated failures, so a struggling
 *   server is never hammered.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const USER_AGENT =
  "cubing-companion/0.1 (personal solve-analysis project; cached, rate-limited, one request at a time)";

export interface CrawlOptions {
  readonly cacheDir: string;
  readonly from: number;
  readonly to: number;
  /** Delay between requests, in milliseconds. */
  readonly delayMs?: number;
  /** Give up after this many consecutive transport failures. */
  readonly maxConsecutiveFailures?: number;
  readonly onProgress?: (progress: CrawlProgress) => void;
}

export interface CrawlProgress {
  readonly id: number;
  readonly status: "cached" | "fetched" | "missing" | "failed";
  readonly fetched: number;
  readonly total: number;
}

export interface CrawlSummary {
  readonly fetched: number;
  readonly cached: number;
  readonly missing: number;
  readonly failed: number;
  readonly abortedAt: number | null;
}

const pagePath = (cacheDir: string, id: number) => join(cacheDir, `${id}.html`);
const missingPath = (cacheDir: string, id: number) => join(cacheDir, `${id}.404`);

/** Whether this id has already been fetched (as a page or as a known gap). */
export function isCached(cacheDir: string, id: number): boolean {
  return existsSync(pagePath(cacheDir, id)) || existsSync(missingPath(cacheDir, id));
}

/** Read a cached page, or `null` if the id is a known gap or was never fetched. */
export async function readCached(
  cacheDir: string,
  id: number,
): Promise<string | null> {
  try {
    return await readFile(pagePath(cacheDir, id), "utf8");
  } catch {
    return null;
  }
}

/**
 * Fetch a range of solve ids into the cache, skipping anything already there.
 *
 * Safe to interrupt and re-run: progress lives in the cache directory, not in memory.
 */
export async function crawl(options: CrawlOptions): Promise<CrawlSummary> {
  const {
    cacheDir,
    from,
    to,
    delayMs = 1500,
    maxConsecutiveFailures = 5,
    onProgress,
  } = options;

  await mkdir(cacheDir, { recursive: true });

  let fetched = 0;
  let cached = 0;
  let missing = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const total = to - from + 1;

  for (let id = from; id <= to; id++) {
    if (isCached(cacheDir, id)) {
      cached++;
      onProgress?.({ id, status: "cached", fetched, total });
      continue;
    }

    let status: CrawlProgress["status"] = "failed";
    try {
      const response = await fetch(`https://reco.nz/solve/${id}`, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
      });

      if (response.status === 404) {
        await writeFile(missingPath(cacheDir, id), "", "utf8");
        missing++;
        status = "missing";
        consecutiveFailures = 0;
      } else if (response.ok) {
        await writeFile(pagePath(cacheDir, id), await response.text(), "utf8");
        fetched++;
        status = "fetched";
        consecutiveFailures = 0;
      } else {
        // 429 or 5xx: back off hard rather than pressing on.
        failed++;
        consecutiveFailures++;
        await sleep(delayMs * 10);
      }
    } catch {
      failed++;
      consecutiveFailures++;
      await sleep(delayMs * 10);
    }

    onProgress?.({ id, status, fetched, total });

    if (consecutiveFailures >= maxConsecutiveFailures) {
      return { fetched, cached, missing, failed, abortedAt: id };
    }

    await sleep(delayMs);
  }

  return { fetched, cached, missing, failed, abortedAt: null };
}
