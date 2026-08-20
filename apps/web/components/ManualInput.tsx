"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_KEY_MAP } from "@cubing-companion/cube-link";

/**
 * Keyboard and paste entry.
 *
 * `PLAN.md` treats this as a first-class input rather than a fallback: it is what keeps
 * every other track moving when the Bluetooth protocol misbehaves, and it is the reason
 * A2 and A3 can be built and tested without hardware.
 */
export function ManualInput({
  onApply,
  onKey,
}: {
  /** Returns an error message, or null on success. */
  onApply: (text: string) => string | null;
  onKey: (key: string) => boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!keyboardActive) return;

    const handler = (event: KeyboardEvent) => {
      // Leave browser and OS shortcuts alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (onKey(event.key)) event.preventDefault();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keyboardActive, onKey]);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // Read the result directly rather than the `error` state, which still holds the
    // previous render's value at this point.
    const message = onApply(trimmed);
    setError(message);
    if (message === null) setText("");
  };

  return (
    <div ref={surfaceRef} className="space-y-3 rounded-md border border-neutral-800 p-3">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Manual input
      </h2>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder={"Paste an algorithm or a whole reconstruction:\nR U R' U' // comments are fine"}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Apply
          </button>
          <span className="text-xs text-neutral-600">or ⌘/Ctrl + Enter</span>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="border-t border-neutral-800 pt-3">
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={keyboardActive}
            onChange={(event) => setKeyboardActive(event.target.checked)}
            className="accent-sky-600"
          />
          Keyboard turning
        </label>
        {keyboardActive && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(DEFAULT_KEY_MAP).map(([key, notation]) => (
              <span
                key={key}
                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
                title={`${key} → ${notation}`}
              >
                {key}
                <span className="text-neutral-600">→</span>
                {notation}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
