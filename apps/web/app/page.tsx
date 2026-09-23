import { CubeHarness } from "@/components/CubeHarness";

/**
 * The app is one screen with three tabs, not a document — so the shell is minimal: no wide
 * desktop gutter, no standing header eating the top third of a phone.
 *
 * `env(safe-area-inset-top)` keeps content clear of the notch; the tab bar handles the bottom.
 */
export default function Home() {
  return (
    <main
      className="mx-auto max-w-2xl px-4 pb-4"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
    >
      <CubeHarness />
    </main>
  );
}
