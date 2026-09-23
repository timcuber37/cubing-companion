/** Opt-in timing observers; no browser globals or retained history when nobody listens. */
type TimingListener = (name: "move-handler" | "planner", durationMs: number, operation?: string) => void;
const listeners = new Set<TimingListener>();

export function onDiagnosticTiming(listener: TimingListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitDiagnosticTiming(name: "move-handler" | "planner", durationMs: number, operation?: string): void {
  for (const listener of listeners) listener(name, durationMs, operation);
}
