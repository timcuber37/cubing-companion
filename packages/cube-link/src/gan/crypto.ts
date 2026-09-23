/**
 * GAN's message encryption.
 *
 * Every byte a GAN cube sends is AES-128 encrypted with a key that is *almost* fixed: a constant
 * shared across the product line, salted with the cube's own MAC address. That is why `mac.ts`
 * exists and why recovering the address matters so much — without it there is no key, and without
 * the key the notifications are noise.
 *
 * Vendored from `gan-web-bluetooth` (MIT, Andy Fedotov), which remains the protocol reference.
 * Two deliberate changes:
 *
 * 1. **`@noble/ciphers` instead of `aes-js`.** `aes-js` is CommonJS, which is what forced the lazy
 *    `await import()` dance in `gan.ts` — a static import made the module unloadable under Node's
 *    ESM loader, so the adapter could not be imported in tests at all. `@noble/ciphers` is ESM and
 *    audited. Verified byte-identical against `aes-js` over all 1,213 frames of the committed
 *    capture, in both directions.
 * 2. **Explicit single-block handling.** The scheme encrypts the first 16 bytes and the last 16
 *    bytes of a message, each as an independent CBC operation from the same fixed IV. For a
 *    20-byte frame those overlap by 12 bytes, and order matters: encryption goes front-then-back,
 *    decryption back-then-front. Getting that backwards produces plausible-looking garbage.
 *
 * `disablePadding` is not optional. Every chunk is exactly one block, and PKCS#7 — which
 * `@noble/ciphers` applies by default — would append a second block and change the length.
 */
import { cbc } from "@noble/ciphers/aes.js";

/** Shared across GAN Gen2, Gen3 and Gen4 cubes. Salted per device; see {@link GanEncrypter}. */
export const GAN_KEY: readonly number[] = [
  0x01, 0x02, 0x42, 0x28, 0x31, 0x91, 0x16, 0x07,
  0x20, 0x05, 0x18, 0x54, 0x42, 0x11, 0x12, 0x53,
];
export const GAN_IV: readonly number[] = [
  0x11, 0x03, 0x32, 0x28, 0x21, 0x01, 0x76, 0x27,
  0x20, 0x95, 0x78, 0x14, 0x32, 0x12, 0x02, 0x43,
];

/** The MoYu AI 2023 speaks the same protocol under a different key. */
export const MOYU_KEY: readonly number[] = [
  0x05, 0x12, 0x02, 0x45, 0x02, 0x01, 0x29, 0x56,
  0x12, 0x78, 0x12, 0x76, 0x81, 0x01, 0x08, 0x03,
];
export const MOYU_IV: readonly number[] = [
  0x01, 0x44, 0x28, 0x06, 0x86, 0x21, 0x22, 0x28,
  0x51, 0x05, 0x08, 0x31, 0x82, 0x02, 0x21, 0x06,
];

const BLOCK = 16;
const MAC_BYTES = 6;

/**
 * Turns a MAC address into the six salt bytes, least significant first.
 *
 * Reversed because that is the order the address goes over the air, and the firmware salts from
 * that form rather than from the printed one.
 */
export function saltFromMac(mac: string): Uint8Array {
  const parts = mac.split(/[:\-\s]+/);
  if (parts.length !== MAC_BYTES) {
    throw new Error(`a MAC address has ${MAC_BYTES} bytes, got ${parts.length}`);
  }
  const salt = new Uint8Array(MAC_BYTES);
  for (const [i, part] of parts.entries()) {
    const byte = Number.parseInt(part, 16);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`"${part}" is not a byte of a MAC address`);
    }
    salt[MAC_BYTES - 1 - i] = byte;
  }
  return salt;
}

export class GanEncrypter {
  private readonly key: Uint8Array;
  private readonly iv: Uint8Array;

  constructor(key: readonly number[], iv: readonly number[], salt: Uint8Array) {
    if (key.length !== BLOCK || iv.length !== BLOCK) {
      throw new Error("key and IV must be 16 bytes");
    }
    if (salt.length !== MAC_BYTES) throw new Error("salt must be 6 bytes");

    this.key = Uint8Array.from(key);
    this.iv = Uint8Array.from(iv);
    for (let i = 0; i < MAC_BYTES; i++) {
      // `% 0xFF`, not `% 0x100`. It looks like a bug and is not one to fix: the firmware wraps the
      // same way, so anything more correct simply fails to decrypt.
      this.key[i] = (key[i]! + salt[i]!) % 0xff;
      this.iv[i] = (iv[i]! + salt[i]!) % 0xff;
    }
  }

  private chunk(buffer: Uint8Array, offset: number, encrypt: boolean): void {
    const cipher = cbc(this.key, this.iv, { disablePadding: true });
    const block = buffer.subarray(offset, offset + BLOCK);
    buffer.set(encrypt ? cipher.encrypt(block) : cipher.decrypt(block), offset);
  }

  encrypt(data: Uint8Array): Uint8Array {
    if (data.length < BLOCK) throw new Error("a message is at least 16 bytes");
    const result = new Uint8Array(data);
    this.chunk(result, 0, true);
    if (result.length > BLOCK) this.chunk(result, result.length - BLOCK, true);
    return result;
  }

  decrypt(data: Uint8Array): Uint8Array {
    if (data.length < BLOCK) throw new Error("a message is at least 16 bytes");
    const result = new Uint8Array(data);
    // Back to front, the exact reverse of `encrypt`, because the two chunks overlap.
    if (result.length > BLOCK) this.chunk(result, result.length - BLOCK, false);
    this.chunk(result, 0, false);
    return result;
  }
}

/** The encrypter for a cube, by name. AiCube-branded devices use MoYu's key. */
export function encrypterFor(deviceName: string | null, mac: string): GanEncrypter {
  const moyu = deviceName?.startsWith("AiCube") === true;
  return new GanEncrypter(moyu ? MOYU_KEY : GAN_KEY, moyu ? MOYU_IV : GAN_IV, saltFromMac(mac));
}
