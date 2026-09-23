import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than build output, so Next has to
  // compile them itself.
  transpilePackages: ["@cubing-companion/engine", "@cubing-companion/cube-link"],

  /**
   * Emit plain HTML/CSS/JS into `out/`, with no Node server.
   *
   * Required for the native shell: a Capacitor app serves its files from the device, so there is
   * nothing to run a server. Costs nothing here — the app has no route handlers that read a
   * request, no dynamic routes and no image optimisation, and every page was already prerendered.
   *
   * See `apps/mobile` and `MOBILE_PLAN.md`.
   */
  output: "export",
};

export default nextConfig;
