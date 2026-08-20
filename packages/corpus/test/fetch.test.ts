/**
 * Crawler tests, against a mocked `fetch`.
 *
 * These matter more than their size suggests: the politeness claims in the README —
 * "cached so the site is hit once per solve, ever", "404s are not retried", "aborts rather
 * than hammering a struggling server" — are only true if this module behaves. Untested,
 * they are just comments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawl, isCached, readCached, USER_AGENT } from "../src/fetch.ts";

let cacheDir: string;
let calls: string[];

const ok = (body: string) =>
  ({ ok: true, status: 200, text: async () => body }) as Response;
const notFound = () => ({ ok: false, status: 404 }) as Response;
const serverError = () => ({ ok: false, status: 503 }) as Response;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    void init;
    return handler(String(url));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "corpus-crawl-"));
  calls = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cacheDir, { recursive: true, force: true });
});

describe("crawling", () => {
  it("writes each fetched page to the cache", async () => {
    mockFetch((url) => ok(`page for ${url}`));
    const summary = await crawl({ cacheDir, from: 1, to: 3, delayMs: 0 });

    expect(summary.fetched).toBe(3);
    expect(calls).toEqual([
      "https://reco.nz/solve/1",
      "https://reco.nz/solve/2",
      "https://reco.nz/solve/3",
    ]);
    expect(await readCached(cacheDir, 2)).toBe("page for https://reco.nz/solve/2");
  });

  it("identifies itself", async () => {
    const spy = mockFetch(() => ok("x"));
    await crawl({ cacheDir, from: 1, to: 1, delayMs: 0 });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/cubing-companion/);
  });

  it("never refetches a cached page", async () => {
    mockFetch(() => ok("first"));
    await crawl({ cacheDir, from: 1, to: 3, delayMs: 0 });
    expect(calls).toHaveLength(3);

    // Second pass over the same range must not touch the network at all.
    calls = [];
    const summary = await crawl({ cacheDir, from: 1, to: 3, delayMs: 0 });
    expect(calls).toEqual([]);
    expect(summary.cached).toBe(3);
    expect(summary.fetched).toBe(0);
  });

  it("records 404s so gaps are not retried on resume", async () => {
    mockFetch((url) => (url.endsWith("/2") ? notFound() : ok("body")));
    const first = await crawl({ cacheDir, from: 1, to: 3, delayMs: 0 });
    expect(first.missing).toBe(1);
    expect(first.fetched).toBe(2);
    expect(isCached(cacheDir, 2)).toBe(true);
    expect(await readCached(cacheDir, 2)).toBeNull();

    calls = [];
    await crawl({ cacheDir, from: 1, to: 3, delayMs: 0 });
    expect(calls).toEqual([]);
  });

  it("extends an existing cache without redoing it", async () => {
    mockFetch(() => ok("body"));
    await crawl({ cacheDir, from: 1, to: 2, delayMs: 0 });
    calls = [];
    const summary = await crawl({ cacheDir, from: 1, to: 4, delayMs: 0 });
    expect(calls).toEqual([
      "https://reco.nz/solve/3",
      "https://reco.nz/solve/4",
    ]);
    expect(summary.cached).toBe(2);
    expect(summary.fetched).toBe(2);
  });

  it("aborts rather than hammering a failing server", async () => {
    mockFetch(() => serverError());
    const summary = await crawl({
      cacheDir,
      from: 1,
      to: 100,
      delayMs: 0,
      maxConsecutiveFailures: 3,
    });
    expect(summary.abortedAt).toBe(3);
    expect(calls).toHaveLength(3);
    expect(summary.failed).toBe(3);
    // Nothing was written, so a resume retries these ids rather than caching an error.
    expect(isCached(cacheDir, 1)).toBe(false);
  });

  it("treats a transport error like a server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const summary = await crawl({
      cacheDir,
      from: 1,
      to: 10,
      delayMs: 0,
      maxConsecutiveFailures: 2,
    });
    expect(summary.abortedAt).toBe(2);
    expect(summary.fetched).toBe(0);
  });

  it("recovers when failures are not consecutive", async () => {
    let seen = 0;
    mockFetch(() => {
      seen++;
      return seen === 2 ? serverError() : ok("body");
    });
    const summary = await crawl({
      cacheDir,
      from: 1,
      to: 4,
      delayMs: 0,
      maxConsecutiveFailures: 2,
    });
    expect(summary.abortedAt).toBeNull();
    expect(summary.fetched).toBe(3);
    expect(summary.failed).toBe(1);
  });

  it("reports progress for each id", async () => {
    mockFetch((url) => (url.endsWith("/2") ? notFound() : ok("body")));
    const statuses: string[] = [];
    await crawl({
      cacheDir,
      from: 1,
      to: 3,
      delayMs: 0,
      onProgress: ({ status }) => statuses.push(status),
    });
    expect(statuses).toEqual(["fetched", "missing", "fetched"]);
  });
});

describe("cache helpers", () => {
  it("reports uncached ids as absent", async () => {
    expect(isCached(cacheDir, 42)).toBe(false);
    expect(await readCached(cacheDir, 42)).toBeNull();
  });

  it("reads back what was written", async () => {
    await writeFile(join(cacheDir, "42.html"), "hello", "utf8");
    expect(isCached(cacheDir, 42)).toBe(true);
    expect(await readCached(cacheDir, 42)).toBe("hello");
  });

  it("creates the cache directory if it does not exist", async () => {
    const nested = join(cacheDir, "deep", "nested");
    expect(existsSync(nested)).toBe(false);
    mockFetch(() => ok("body"));
    await crawl({ cacheDir: nested, from: 1, to: 1, delayMs: 0 });
    expect(await readFile(join(nested, "1.html"), "utf8")).toBe("body");
  });
});
