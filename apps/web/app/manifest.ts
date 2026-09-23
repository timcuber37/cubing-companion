import type { MetadataRoute } from "next";

/**
 * The manifest is a route handler, and route handlers are not cached by default — so a static
 * export refuses to build without being told this one is constant. It is: the function below reads
 * nothing and returns the same object every time.
 */
export const dynamic = "force-static";

/**
 * The web app manifest, which is what makes this installable.
 *
 * On Android this is most of the job: Chrome already supports Web Bluetooth, so an installed PWA
 * is a real, working phone app today — no store, no native shell. On iOS it is groundwork rather
 * than a solution; Safari has no Web Bluetooth, so an installed PWA there gets everything except
 * the cube, which is the point of the Capacitor work in `MOBILE_PLAN.md`.
 *
 * `background_color` matches the `bg-neutral-950` on `body`, so the splash screen does not flash a
 * different colour than the app it is about to show.
 *
 * Icons are generated: `npm run generate-icons -w @cubing-companion/web`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Cubing Companion",
    // What fits under a home-screen icon before the launcher truncates it.
    short_name: "Cubing",
    description: "Record solves from a smart cube and see where the time went.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Cropped to the launcher's own shape, so its artwork sits inside the safe circle.
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
