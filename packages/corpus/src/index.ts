/**
 * @cubing-companion/corpus — the pro reconstruction corpus.
 *
 * Fetch (cached, rate-limited) -> parse -> classify -> verify -> segment -> summarize.
 * The pipeline is deliberately staged so a change to any later step never forces a
 * refetch of an earlier one.
 */

export { crawl, isCached, readCached, USER_AGENT } from "./fetch.ts";
export type { CrawlOptions, CrawlProgress, CrawlSummary } from "./fetch.ts";

export {
  EmptyReconstructionError,
  ParseError,
  parseSolvePage,
  parseStats,
  peekEvent,
} from "./parse.ts";

export { classifyMethod, methodMarker, normalizeLabel } from "./labels.ts";
export type { NormalizedLabel } from "./labels.ts";

export { labelsOf, segmentSolve, splitAnnotatedLines } from "./segment.ts";
export type { SegmentationResult } from "./segment.ts";

export { summarize, percentile } from "./stats.ts";
export type { CorpusSummary, PhaseSummary, Distribution } from "./stats.ts";

export {
  F2L_PHASES,
  Method,
  Phase,
  type Quality,
  type RawSolve,
  type Rejection,
  type RejectionReason,
  type Segment,
  type SolveRecord,
  type SolveStats,
  type StatGroup,
} from "./types.ts";
