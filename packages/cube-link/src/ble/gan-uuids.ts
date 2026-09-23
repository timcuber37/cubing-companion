/**
 * What a GAN cube looks like on the air.
 *
 * Only what discovery and subscription need: service and characteristic UUIDs, the company codes
 * the MAC hides in, and the name prefixes the chooser filters on. The protocol itself — framing,
 * encryption, what the bytes mean — is deliberately not here; that arrives when the driver is
 * vendored, and keeping the two apart is what lets frames be captured before anything can decode
 * them.
 *
 * Values are from `gan-web-bluetooth` (MIT, Andy Fedotov), which remains the reference for the
 * protocol. They are constants of the hardware rather than of that library.
 */

/** The three protocol generations, distinguished by which service the cube exposes. */
export type GanProtocol = "gen2" | "gen3" | "gen4";

export interface GanServiceProfile {
  readonly protocol: GanProtocol;
  readonly service: string;
  /** Written to, to ask the cube for something. Encrypted; the driver builds the payload. */
  readonly commandCharacteristic: string;
  /** Notifies. Every move, facelet report and hardware reply arrives here, encrypted. */
  readonly stateCharacteristic: string;
}

export const GAN_SERVICES: readonly GanServiceProfile[] = [
  {
    protocol: "gen2",
    service: "6e400001-b5a3-f393-e0a9-e50e24dc4179",
    commandCharacteristic: "28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4",
    stateCharacteristic: "28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4",
  },
  {
    protocol: "gen3",
    service: "8653000a-43e6-47b7-9cb0-5fc21d4ae340",
    commandCharacteristic: "8653000c-43e6-47b7-9cb0-5fc21d4ae340",
    stateCharacteristic: "8653000b-43e6-47b7-9cb0-5fc21d4ae340",
  },
  {
    protocol: "gen4",
    service: "00000010-0000-fff7-fff6-fff5fff4fff0",
    commandCharacteristic: "0000fff5-0000-1000-8000-00805f9b34fb",
    stateCharacteristic: "0000fff6-0000-1000-8000-00805f9b34fb",
  },
];

/**
 * Which profile a peripheral speaks, from the services it exposes.
 *
 * Returns null rather than throwing: an unsupported cube is a thing the UI should explain, not an
 * exception in a transport.
 */
export function profileFor(services: readonly string[]): GanServiceProfile | null {
  const available = new Set(services.map((uuid) => uuid.toLowerCase()));
  return GAN_SERVICES.find((profile) => available.has(profile.service)) ?? null;
}

/** GAN, MoYu and AiCube devices all speak this protocol; the chooser filters on their names. */
export const GAN_NAME_PREFIXES: readonly string[] = ["GAN", "MG", "AiCube"];

/**
 * Every Company Identifier Code a GAN cube might advertise under: `[0x0001, 0xFF01]`.
 *
 * All 256 of them, because which one a given cube uses is not predictable from anything we can
 * see beforehand, and a platform only surfaces manufacturer data for codes we asked about.
 */
export const GAN_COMPANY_IDS: readonly number[] = Array.from(
  { length: 256 },
  (_, i) => (i << 8) | 0x01,
);
