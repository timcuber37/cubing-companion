/**
 * Generates the app icons.
 *
 * Run: npm run generate-icons -w @cubing-companion/web
 *
 * Generated rather than drawn in a design tool for the same reason `tables.generated.ts` is: the
 * artwork is pure convention, and a committed binary nobody can regenerate is a dead end the first
 * time a size or a colour needs to change. The output is committed — installing a PWA needs the
 * files present, not a build step.
 *
 * The icon is a **white cross on a cube face**: centre plus four edges white, the corners still
 * scrambled. That is the thing the planner plans, and it reads at 48px, which is the size that
 * actually matters — a home screen and a browser tab are both small.
 *
 * Every icon is an opaque square. Platforms that want a shape apply their own — iOS masks the
 * apple-touch-icon to a squircle, Android masks the `maskable` entry to whatever the launcher
 * uses — so rounding the corners here would either be invisible or fight the mask. The only
 * concession is that the maskable icon pulls its grid further in, to sit inside the 80% safe circle.
 *
 * PNG is written by hand: one signature, three chunks, a CRC each. Pulling in an image library to
 * avoid forty lines of that would be the larger cost, and this way the script has no dependencies
 * and runs on a clean checkout.
 */
import { crc32, deflateSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** Rendered at this multiple and box-filtered down, which is what keeps the sticker edges smooth. */
const SUPERSAMPLE = 4;

type Rgb = readonly [number, number, number];

const GROUND: Rgb = [10, 10, 10]; // neutral-950, the app's own background
/**
 * Cube colours, brightened from the WCA plastics so they hold against a near-black ground.
 * Faithful red and blue in particular go muddy at icon sizes.
 */
const WHITE: Rgb = [244, 244, 245];
const GREEN: Rgb = [34, 197, 94];
const RED: Rgb = [244, 63, 94];
const BLUE: Rgb = [56, 130, 246];
const ORANGE: Rgb = [249, 115, 22];

/** Centre and the four edges make the cross; the corners are whatever they happened to be. */
const FACE: readonly Rgb[] = [
  GREEN, WHITE, RED,
  WHITE, WHITE, WHITE,
  ORANGE, WHITE, BLUE,
];

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Is this sample inside the rounded rectangle?
 *
 * Clamp the point into the rectangle shrunk by the corner radius, then measure back to it: zero in
 * the middle, a straight edge along the sides, and the corner arc where both axes are outside.
 */
function insideRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  size: number,
  radius: number,
): boolean {
  if (x < left || x > left + size || y < top || y > top + size) return false;
  const cx = clamp(x, left + radius, left + size - radius);
  const cy = clamp(y, top + radius, top + size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/**
 * @param inset fraction of the canvas the 3x3 grid spans.
 */
function render(size: number, inset: number): Buffer {
  const scale = size * SUPERSAMPLE;
  const accumulator = new Float64Array(size * size * 3);

  const span = scale * inset;
  const origin = (scale - span) / 2;
  const gap = span * 0.055;
  const sticker = (span - gap * 2) / 3;
  const radius = sticker * 0.16;

  for (let sy = 0; sy < scale; sy++) {
    for (let sx = 0; sx < scale; sx++) {
      let colour = GROUND;
      const x = sx + 0.5;
      const y = sy + 0.5;

      // Which cell this sample lands in, if any. Nine tests per sample is nothing at these sizes.
      const column = Math.floor((x - origin) / (sticker + gap));
      const row = Math.floor((y - origin) / (sticker + gap));
      if (row >= 0 && row < 3 && column >= 0 && column < 3) {
        const left = origin + column * (sticker + gap);
        const top = origin + row * (sticker + gap);
        if (insideRoundedRect(x, y, left, top, sticker, radius)) {
          colour = FACE[row * 3 + column]!;
        }
      }

      const target = (Math.floor(sy / SUPERSAMPLE) * size + Math.floor(sx / SUPERSAMPLE)) * 3;
      accumulator[target] = accumulator[target]! + colour[0];
      accumulator[target + 1] = accumulator[target + 1]! + colour[1];
      accumulator[target + 2] = accumulator[target + 2]! + colour[2];
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 3;
      raw[offset++] = Math.round(accumulator[source]! / samples);
      raw[offset++] = Math.round(accumulator[source + 1]! / samples);
      raw[offset++] = Math.round(accumulator[source + 2]! / samples);
    }
  }

  return png(size, raw);
}

/** One PNG chunk: length, type, data, and a CRC over the type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type 2: truecolour RGB, no alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GRID = 0.66;
/** A launcher crops a maskable icon to the central 80%, so its grid has to sit well inside that. */
const GRID_MASKABLE = 0.52;

/** A launch screen is mostly ground with a small mark, not a big icon. */
const GRID_SPLASH = 0.22;

const OUTPUTS: readonly { path: string; size: number; inset: number }[] = [
  // Next.js file conventions: the browser tab, and the iOS home screen when installed from Safari.
  { path: "app/icon.png", size: 256, inset: GRID },
  { path: "app/apple-icon.png", size: 180, inset: GRID },
  // Referenced by app/manifest.ts, so these live where the manifest's URLs point.
  { path: "public/icon-192.png", size: 192, inset: GRID },
  { path: "public/icon-512.png", size: 512, inset: GRID },
  { path: "public/icon-maskable-512.png", size: 512, inset: GRID_MASKABLE },
];

/**
 * The native app's own assets, which Xcode reads from the asset catalogue rather than from the web
 * bundle. Same artwork, so the installed app looks like the site it came from instead of shipping
 * Capacitor's placeholder.
 *
 * Skipped when `apps/mobile` is absent, so a checkout without the native project still generates.
 */
const IOS = `${WEB}../mobile/ios/App/App/Assets.xcassets/`;
const NATIVE: readonly { path: string; size: number; inset: number }[] = [
  { path: `${IOS}AppIcon.appiconset/AppIcon-512@2x.png`, size: 1024, inset: GRID },
  { path: `${IOS}Splash.imageset/splash-2732x2732.png`, size: 2732, inset: GRID_SPLASH },
  { path: `${IOS}Splash.imageset/splash-2732x2732-1.png`, size: 2732, inset: GRID_SPLASH },
  { path: `${IOS}Splash.imageset/splash-2732x2732-2.png`, size: 2732, inset: GRID_SPLASH },
];

for (const { path, size, inset } of OUTPUTS) {
  const file = `${WEB}${path}`;
  mkdirSync(dirname(file), { recursive: true });
  const bytes = render(size, inset);
  writeFileSync(file, bytes);
  console.log(`  ${path}  ${size}px, ${(bytes.length / 1024).toFixed(1)} KB`);
}

for (const { path, size, inset } of NATIVE) {
  if (!existsSync(dirname(path))) {
    console.log(`  skipped ${path.replace(IOS, "ios: ")} (no native project)`);
    continue;
  }
  const bytes = render(size, inset);
  writeFileSync(path, bytes);
  console.log(`  ${path.replace(IOS, "ios: ")}  ${size}px, ${(bytes.length / 1024).toFixed(1)} KB`);
}
