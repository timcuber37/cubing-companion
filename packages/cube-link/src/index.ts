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
  type GanTransportInfo,
  type GanDiagnosticPacket,
} from "./gan.ts";

export {
  GanDiagnosticRecorder,
  diagnosticDistribution,
  type DiagnosticCapture,
  type DiagnosticEvent,
  type DiagnosticMode,
  type DiagnosticSummary,
} from "./diagnostics.ts";

/**
 * The BLE transport seam.
 *
 * One description of a radio, satisfied by Web Bluetooth today and by a native bridge later, so
 * the protocol above it never learns which it got. See `ble/transport.ts`, and `MOBILE_PLAN.md`
 * for why it exists.
 */
export {
  BleTransportError,
  MemoryMacStore,
  type BleAdvertisement,
  type BleConnection,
  type BlePeripheral,
  type BleScanFilter,
  type BleTransport,
  type GanMacStore,
} from "./ble/transport.ts";

export { WebBluetoothTransport, type WebBluetoothTransportOptions } from "./ble/web.ts";

export {
  fakeAdvertisement,
  FakePeripheral,
  FakeTransport,
  type FakeFrame,
  type FakeWrite,
} from "./ble/fake.ts";

export {
  GAN_COMPANY_IDS,
  GAN_NAME_PREFIXES,
  GAN_SERVICES,
  profileFor,
  type GanProtocol,
  type GanServiceProfile,
} from "./ble/gan-uuids.ts";

export {
  formatMac,
  isValidMac,
  macFromAdvertisement,
  parseMac,
  resolveMac,
  type MacSource,
  type ResolvedMac,
} from "./ble/mac.ts";

/**
 * The vendored GAN protocol.
 *
 * Decoding, encryption and connection management, over a {@link BleTransport} rather than over a
 * browser API. `test/protocol.test.ts` diffs every one of these against the reference
 * implementation it was ported from.
 */
export {
  connectGanCube,
  GanConnection,
  type GanConnectionOptions,
} from "./gan/connection.ts";

export { GanEncrypter, encrypterFor, saltFromMac } from "./gan/crypto.ts";
export { GanMessageView } from "./gan/message.ts";
export { isCube, toKociembaFacelets } from "./gan/facelets.ts";
export type {
  GanCubeCommand,
  GanCubeEvent,
  GanProtocolDriver,
} from "./gan/events.ts";

export {
  captureProtocolFrames,
  framesToBytes,
  ProtocolCaptureSession,
  type CaptureOptions,
  type CaptureStopReason,
  type CaptureSummary,
  type CapturedFrame,
  type ProtocolCapture,
} from "./ble/capture.ts";
