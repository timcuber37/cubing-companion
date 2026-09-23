/**
 * Reading bit-packed fields out of a cube message.
 *
 * GAN's messages are not byte-aligned — a Gen2 facelet report packs eight 3-bit corner
 * permutations, eight 2-bit orientations, twelve 4-bit edge permutations and twelve 1-bit edge
 * orientations into twenty bytes. Fields start at arbitrary bit offsets and most are narrower
 * than a byte.
 *
 * Vendored from `gan-web-bluetooth` (MIT, Andy Fedotov). The reference builds a string of '0' and
 * '1' characters and calls `parseInt` on slices of it, which is clear but allocates a 160-character
 * string per message and re-parses it per field. This reads the bits arithmetically instead:
 * identical results, no allocation, and it matters because a cube sends one of these every few
 * milliseconds while a phone is trying to animate a cube at 60fps.
 *
 * `test/protocol.test.ts` asserts the two agree over random messages and offsets.
 */

/** Widths the protocol actually uses. 16 and 32 additionally support little-endian byte order. */
export class GanMessageView {
  constructor(private readonly bytes: Uint8Array) {}

  /**
   * Read `length` bits starting at `start`, most significant bit first.
   *
   * @param littleEndian only meaningful for 16- and 32-bit words, and only then because the
   * fields those describe — cube timestamps and serials — are stored byte-swapped.
   */
  word(start: number, length: number, littleEndian = false): number {
    if (length <= 8) return this.bits(start, length);

    if (length === 16 || length === 32) {
      const bytes = length / 8;
      let value = 0;
      for (let i = 0; i < bytes; i++) {
        const byte = this.bits(start + i * 8, 8);
        // Shift into place by position, so the result is the same on any platform.
        value += byte * 2 ** (8 * (littleEndian ? i : bytes - 1 - i));
      }
      return value;
    }

    throw new Error(`unsupported bit word length: ${length}`);
  }

  /** Bits that do not cross a byte boundary are one mask; the rest are assembled. */
  private bits(start: number, length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) {
      const bit = start + i;
      const byte = this.bytes[bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    return value;
  }
}

/** Sum of an array, as the permutation checksums need. */
export const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
