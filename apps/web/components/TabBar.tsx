"use client";

/**
 * The bottom tab bar, and the phone-first information architecture it implies.
 *
 * The app was built as a two-column desktop grid, which on a phone collapses into one very long
 * column — legible, but wrong: the primary action ends up below the fold, and diagnostics sit
 * between you and your solve history. Three tabs put each job on its own screen.
 *
 * **Bottom**, not top, because that is the third of the screen a thumb reaches. Everything the app
 * asks you to do while holding a cube should be reachable without changing grip.
 *
 * `env(safe-area-inset-bottom)` is what keeps the bar clear of the home indicator. Without it the
 * bar sits under the indicator on every modern iPhone and the last few pixels stop being tappable.
 */

export type Tab = "solve" | "history" | "settings";

const TABS: readonly { id: Tab; label: string; icon: string }[] = [
  { id: "solve", label: "Solve", icon: "M12 2.8l7.5 4.3v9.8L12 21.2 4.5 16.9V7.1zM12 2.8v9.4m0 0l7.5-4.3M12 12.2l-7.5-4.3M12 12.2v9" },
  { id: "history", label: "History", icon: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { id: "settings", label: "Settings", icon: "M10.3 4.3a2 2 0 013.4 0l.6 1a2 2 0 002.3 1l1-.3a2 2 0 012.4 2.4l-.3 1a2 2 0 001 2.3l1 .6a2 2 0 010 3.4l-1 .6a2 2 0 00-1 2.3l.3 1a2 2 0 01-2.4 2.4l-1-.3a2 2 0 00-2.3 1l-.6 1a2 2 0 01-3.4 0l-.6-1a2 2 0 00-2.3-1l-1 .3a2 2 0 01-2.4-2.4l.3-1a2 2 0 00-1-2.3l-1-.6a2 2 0 010-3.4l1-.6a2 2 0 001-2.3l-.3-1a2 2 0 012.4-2.4l1 .3a2 2 0 002.3-1zM12 15a3 3 0 100-6 3 3 0 000 6z" },
];

export function TabBar({
  active,
  onChange,
  badge,
  action,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
  /** Count shown on History, so a saved solve is visible from any tab. */
  badge?: number;
  /**
   * The screen's primary action, docked directly above the tabs.
   *
   * In the same fixed container rather than a second one, so the two cannot drift apart or need a
   * hard-coded offset for the tab bar's height.
   */
  action?: React.ReactNode;
}) {
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {action && <div className="mx-auto max-w-2xl px-4 pb-1 pt-2">{action}</div>}
      <ul className="mx-auto flex max-w-2xl">
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <li key={tab.id} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(tab.id)}
                aria-current={selected ? "page" : undefined}
                className={`flex w-full flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium transition-colors ${
                  selected ? "text-sky-400" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span className="relative">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d={tab.icon} />
                  </svg>
                  {tab.id === "history" && badge !== undefined && badge > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-neutral-700 px-1 text-center text-[10px] leading-4 text-neutral-200">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </span>
                {tab.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
