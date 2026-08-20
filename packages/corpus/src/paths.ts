/**
 * Where corpus data lives.
 *
 * Everything under `data/` is gitignored and reproducible: the raw cache is reco.nz's
 * data and is not redistributed, and the derived corpus can be rebuilt from it. Only the
 * code and the summary statistics are committed.
 */
import { fileURLToPath } from "node:url";

/** Repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Raw HTML cache, one file per solve id. Never redistributed. */
export const CACHE_DIR = fileURLToPath(new URL("../../../data/raw/", import.meta.url));

/** Derived corpus, one JSON record per line. */
export const CORPUS_PATH = fileURLToPath(
  new URL("../../../data/corpus.jsonl", import.meta.url),
);

/** Solves that did not make it in, with reasons, so the funnel stays auditable. */
export const REJECTIONS_PATH = fileURLToPath(
  new URL("../../../data/rejections.jsonl", import.meta.url),
);

/** Summary statistics — the one derived artefact small enough to commit. */
export const SUMMARY_PATH = fileURLToPath(
  new URL("../../../data/summary.json", import.meta.url),
);
