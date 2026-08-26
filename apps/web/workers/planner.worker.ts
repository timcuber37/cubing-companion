/**
 * The planner sweep, off the main thread.
 *
 * A colour-neutral sweep — cross plus all four xcrosses, for every colour — runs a median of
 * 1.9 s and a worst case over 5 s. That is not something the UI thread can absorb: the cube stops
 * animating, the buttons stop responding, and the app looks broken exactly when it is working.
 *
 * A2 concluded workers were unusable here, but that was cubing.js's WASM *module* worker
 * specifically. A plain worker built from our own TypeScript loads and runs fine under Turbopack,
 * which was verified in a browser before this was written.
 *
 * Results are posted **per colour rather than in one batch**, so the first cross appears in about
 * 150 ms instead of after the whole sweep. The cross tables live in module scope, so a second
 * request to the same worker skips the ~490 ms of table building the first one paid.
 */
import { fromFacelets, type Face } from "@cubing-companion/engine";
import { planColour, type ColourPlan } from "@cubing-companion/planner";

export interface PlanRequest {
  /** Echoed back, so the page can drop results for a position it has already moved on from. */
  readonly id: number;
  readonly facelets: string;
  readonly crossFaces: number[];
  readonly keep?: number;
  readonly crossOnly?: boolean;
}

export type PlanResponse =
  | { readonly id: number; readonly kind: "colour"; readonly plan: ColourPlan }
  | { readonly id: number; readonly kind: "done"; readonly elapsedMs: number }
  | { readonly id: number; readonly kind: "error"; readonly message: string };

const post = (message: PlanResponse): void => {
  (self as unknown as Worker).postMessage(message);
};

self.onmessage = (event: MessageEvent<PlanRequest>) => {
  const request = event.data;
  const startedAt = Date.now();

  try {
    const state = fromFacelets(request.facelets);
    for (const face of request.crossFaces) {
      post({
        id: request.id,
        kind: "colour",
        plan: planColour(state, face as Face, {
          keep: request.keep ?? 3,
          crossOnly: request.crossOnly ?? false,
        }),
      });
    }
    post({ id: request.id, kind: "done", elapsedMs: Date.now() - startedAt });
  } catch (error) {
    // A malformed facelet string is the likely cause, and it must not kill the worker: the next
    // request would then find nothing listening.
    post({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
