/**
 * Getting a scorer for one of B3's heads.
 *
 * The one place that turns a name into a {@link ScoreFn}. Separate from `mlp.ts` because that file
 * is arithmetic over any weight set, and separate from `weights.generated.ts` because that file is
 * data and nothing else — the same split `metrics` draws between `baselines.ts` and
 * `baselines.generated.ts`.
 *
 * Returning `null` rather than throwing is deliberate, and predates this: a missing model should
 * cost the *learned* ranking, not the planner. Callers fall back to move count and say so in the
 * UI. It stays reachable because a head whose checkpoint was never trained generates as `null`.
 */
import { scorerFrom } from "./mlp.ts";
import type { ScoreFn } from "./rank.ts";
import { WEIGHTS, type RankerName } from "./weights.generated.ts";

/** Built once per head and reused; validation and closure setup need not be repeated. */
const cache = new Map<RankerName, ScoreFn | null>();

/**
 * The scorer for one head, or `null` when this build has no weights for it.
 *
 * Synchronous, because the weights are bundled. Nothing is fetched, so nothing can fail partway.
 */
export function scorerFor(name: RankerName): ScoreFn | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const weights = WEIGHTS[name];
  // Malformed weights are a build-time mistake, not a runtime condition, so let `scorerFrom`
  // throw rather than degrading quietly into the heuristic and looking like a bad model.
  const scorer = weights === null ? null : scorerFrom(weights);
  cache.set(name, scorer);
  return scorer;
}
