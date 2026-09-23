"use client";

import { useEffect, useRef } from "react";
import { isNativeShell } from "./platform";

/**
 * The two things a phone does that a browser tab does not: dim its screen, and suspend the app.
 *
 * Both are handled here rather than inline, because both are easy to get subtly wrong in ways that
 * only show up on hardware — a wake lock that leaks and flattens the battery, or a reconnect that
 * fires on every foreground and stacks up connections.
 *
 * Every plugin is imported dynamically and every failure is swallowed. None of this is load-bearing:
 * a browser has no bridge to call, and an app whose screen dims is worse than one whose screen does
 * not, but an app that fails to start because a plugin was missing is worse than both.
 */

/**
 * Hold the screen awake while `active`.
 *
 * Tied to the recorder's phase by the caller, so the screen stays lit through inspection and the
 * solve and releases the moment the solve is saved. A cuber looking at a scramble is not touching
 * the screen, and iOS will dim and lock right at the point of maximum annoyance.
 *
 * Release is idempotent and also runs on unmount, so the lock cannot outlive the component that
 * asked for it.
 */
export function useKeepAwake(active: boolean): void {
  // Tracks what we actually asked for, so a re-render with the same value is not a second call.
  const held = useRef(false);

  useEffect(() => {
    if (!isNativeShell()) return;

    let cancelled = false;
    const apply = async (wantAwake: boolean) => {
      if (cancelled || held.current === wantAwake) return;
      held.current = wantAwake;
      try {
        const { KeepAwake } = await import("@capacitor-community/keep-awake");
        await (wantAwake ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
      } catch {
        // No plugin, or a platform that cannot do it. The app still works; the screen dims.
      }
    };

    void apply(active);
    return () => {
      cancelled = true;
      // Deliberately not guarded by `active`: unmounting while awake must still release.
      if (held.current) {
        held.current = false;
        void import("@capacitor-community/keep-awake")
          .then(({ KeepAwake }) => KeepAwake.allowSleep())
          .catch(() => {});
      }
    };
  }, [active]);
}

/**
 * Run `onResume` when the app comes back to the foreground.
 *
 * iOS suspends a backgrounded app within seconds and drops its BLE connections with it, so coming
 * back to the app is coming back to a cube that is no longer attached. The handler is how the app
 * notices — without one, the UI claims a connection that is not there until the user tries to turn
 * something.
 *
 * The handler is held in a ref so that changing it does not tear down and re-register the
 * listener, which on some plugin versions is how you end up with two.
 */
export function useAppResume(onResume: () => void): void {
  const handler = useRef(onResume);
  handler.current = onResume;

  useEffect(() => {
    if (!isNativeShell()) return;

    let remove: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const listener = await App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) handler.current();
        });
        if (cancelled) {
          void listener.remove();
          return;
        }
        remove = () => void listener.remove();
      } catch {
        // No plugin; nothing to listen to.
      }
    })();

    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);
}
