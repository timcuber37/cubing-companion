/**
 * @cubing-companion/cube-link — cube input adapters.
 *
 * One interface, several sources: a GAN smart cube over Web Bluetooth, manual keyboard and
 * paste entry, and recorded replay. Downstream code consumes {@link CubeSource} and never
 * learns which it got, which is what `PLAN.md` means by an input-agnostic analysis engine.
 *
 * Nothing here imports UI, and analysis must never import this.
 */

export {
  Listeners,
  type CubeSource,
  type DesyncEvent,
  type MoveEvent,
  type SourceKind,
  type Unsubscribe,
} from "./source.ts";

export { MoveTimeline, type TimedMove, type TimelineOptions } from "./timeline.ts";

export { CubeTracker, serialGap, type TrackerOptions } from "./tracker.ts";

export {
  DEFAULT_KEY_MAP,
  ManualSource,
  type ManualSourceOptions,
} from "./manual.ts";

export {
  recordingFromAlg,
  ReplaySource,
  type RecordedMove,
  type ReplaySourceOptions,
} from "./replay.ts";

export {
  connectSmartCube,
  GanCubeSource,
  isWebBluetoothAvailable,
  parseGanMove,
  SmartCubeError,
  type GanConnectionLike,
  type GanCubeSourceOptions,
  type GanEventLike,
  type MacAddressPrompt,
  type GanHardwareInfo,
} from "./gan.ts";
