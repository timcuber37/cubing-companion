/**
 * Architecture guard for the transport seam.
 *
 * The seam is only worth anything if it holds. One convenience reach for `navigator` outside
 * `ble/web.ts` and the package stops being portable — and the symptom would not appear here, it
 * would appear on an iPhone, months later, as a blank screen. Same for the reverse direction:
 * `ble/` is meant to be the layer that knows about radios and nothing about cube state, so a
 * drift the other way is just as much a regression.
 *
 * Reading the source is cruder than a lint rule but needs no tooling and fails loudly. Modelled on
 * `packages/analysis/test/boundaries.test.ts`, which guards the same kind of rule.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The one file allowed to know Web Bluetooth exists. */
const RADIO_OWNER = "ble/web.ts";

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

/** Module specifiers a file imports from. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Strips comments, so prose *about* `navigator` does not read as a use of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("transport boundaries", () => {
  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files.map((file) => file.name)).toContain(RADIO_OWNER);
  });

  it("touches Web Bluetooth in exactly one file", () => {
    const offenders = files
      .filter((file) => file.name !== RADIO_OWNER)
      .filter((file) => /\bnavigator\b/.test(code(file.text)))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("keeps the radio out of the pure sources entirely", () => {
    // These are the files a native port reuses verbatim. Nothing here may assume a platform.
    const pure = ["source.ts", "manual.ts", "replay.ts", "tracker.ts", "timeline.ts", "diagnostics.ts"];
    for (const name of pure) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file, name).toBeDefined();
      expect(code(file!.text), name).not.toMatch(/\bnavigator\b|\bwindow\b|\bdocument\b/);
    }
  });

  it("does not import the reference implementation at all", () => {
    // The protocol is vendored into `src/gan/`; `gan-web-bluetooth` is a devDependency that exists
    // only so `test/protocol.test.ts` can keep diffing against it. If it reappears here, the
    // shipping path has taken a dependency on Web Bluetooth again and iOS is blocked again.
    const offenders = files
      .filter((file) => /from\s+["']gan-web-bluetooth|import\(["']gan-web-bluetooth/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("keeps the vendored protocol off the radio", () => {
    // `src/gan/` decodes bytes. It may name the transport interface and the constants describing a
    // GAN cube, but it must not reach for an implementation — that is what makes the same decoder
    // run over Web Bluetooth, a native bridge, and a recorded capture.
    const allowed = /^(\.\/|\.\.\/source\.ts|\.\.\/ble\/(transport|gan-uuids|mac)\.ts|@noble\/)/;
    const offenders: string[] = [];
    for (const file of files.filter((candidate) => candidate.name.startsWith("gan/"))) {
      for (const specifier of importsOf(file.text)) {
        if (!allowed.test(specifier)) offenders.push(`${file.name} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("touches Capacitor in exactly one file", () => {
    // Same rule as Web Bluetooth, for the same reason in the other direction: `ble/capacitor.ts`
    // is the native radio and nothing else may assume one is there. It is also why the package
    // still installs, and the web app still builds, with Capacitor absent.
    const offenders = files
      .filter((file) => file.name !== "ble/capacitor.ts")
      .filter((file) => importsOf(file.text).some((specifier) => specifier.startsWith("@capacitor")))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("does not export the native transport from the barrel", () => {
    // It has its own entry point. Exporting it here would put `@capacitor-community/bluetooth-le`
    // into the module graph of every consumer, including the web build that has no use for it —
    // the same mistake the engine barrel made with cubing.js's solver.
    const barrel = files.find((file) => file.name === "index.ts")!;
    expect(barrel.text).not.toMatch(/from\s+["']\.\/ble\/capacitor\.ts["']/);
  });

  it("keeps the transport interfaces free of every import but our own types", () => {
    const transport = files.find((file) => file.name === "ble/transport.ts")!;
    const external = [...transport.text.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith("."));
    expect(external).toEqual([]);
  });

  it("does not let the BLE layer reach back up into cube state", () => {
    // `ble/` is below the protocol: it moves bytes. If it starts importing the engine, the seam
    // has stopped being a seam.
    const offenders = files
      .filter((file) => file.name.startsWith("ble/"))
      .filter((file) => /from\s+["']@cubing-companion\/engine["']/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
