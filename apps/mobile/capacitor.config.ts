import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The native shell.
 *
 * There is no application code here. `webDir` points at `apps/web`'s static export, so the phone
 * runs exactly the bundle the browser runs — the same components, the same planner worker, the
 * same vendored protocol. What the shell adds is a native Bluetooth radio, which is the one thing
 * a browser on iOS cannot provide and the whole reason this directory exists.
 *
 * See `MOBILE_PLAN.md` for why Capacitor rather than React Native.
 */
const config: CapacitorConfig = {
  // Reverse-DNS, and arbitrary while the app is sideloaded to personal devices. Changing it later
  // makes iOS treat the result as a different app, which loses whatever it had stored.
  appId: "com.cubingcompanion.app",
  appName: "Cubing Companion",

  // Relative to this file. `npm run sync` rebuilds it before copying.
  webDir: "../web/out",

  ios: {
    /**
     * Matches `bg-neutral-950` on `body`, so the launch screen does not flash white before the
     * app paints. The web app is dark-only.
     */
    backgroundColor: "#0a0a0a",
    /**
     * `scrollEnabled` is deliberately absent, i.e. left at its default of `true`.
     *
     * It was set to `false` here to suppress rubber-band overscroll. That is not what it does: it
     * turns off the web view's scroll view altogether, so the page could not scroll at all. If
     * overscroll ever needs taming, `overscroll-behavior` in CSS is the tool.
     *
     * `contentInset: "never"` because safe areas are handled in CSS, with `env(safe-area-inset-*)`
     * and `viewportFit: "cover"` in `app/layout.tsx`. Letting the web view inset the content as
     * well would pad everything twice and leave two places to look when the spacing is wrong.
     */
    contentInset: "never",
  },
};

export default config;
