/**
 * Architecture guard for the storage layer.
 *
 * Three implementations of one interface, each right for a different place: memory for tests and
 * server rendering, IndexedDB for a browser, SQLite for the phone. The rule that keeps that from
 * costing anything is that **the native one is reachable only through its own entry point** — put
 * it in the barrel and every consumer, including the web build, drags the Capacitor plugin into
 * its module graph.
 *
 * Same rule and same reasoning as `packages/cube-link/test/boundaries.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The one file allowed to know Capacitor exists. */
const NATIVE_OWNER = "sqlite-capacitor.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

const importsOf = (text: string) =>
  [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);

describe("storage boundaries", () => {
  it("has sources to check", () => {
    expect(files.map((file) => file.name)).toContain(NATIVE_OWNER);
  });

  it("touches Capacitor in exactly one file", () => {
    const offenders = files
      .filter((file) => file.name !== NATIVE_OWNER)
      .filter((file) => importsOf(file.text).some((spec) => spec.startsWith("@capacitor")))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("does not export the native store from the barrel", () => {
    const barrel = files.find((file) => file.name === "index.ts")!;
    expect(barrel.text).not.toMatch(/from\s+["']\.\/sqlite-capacitor\.ts["']/);
  });

  it("keeps the SQL itself free of any platform", () => {
    // `sqlite.ts` holds every statement the app runs, and reaches its database through a
    // four-method interface. That is what lets the contract test run the real SQL under
    // `node:sqlite` — if a driver leaks in here, that coverage quietly stops being real.
    const store = files.find((file) => file.name === "sqlite.ts")!;
    const external = importsOf(store.text).filter((spec) => !spec.startsWith("."));
    expect(external).toEqual([]);
  });
});
