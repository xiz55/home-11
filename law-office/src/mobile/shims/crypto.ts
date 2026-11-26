// بديل node:crypto على الآيفون: نفس الخوارزميات (scrypt، SHA-256) بمكتبة noble المدققة، والعشوائية من مولد النظام.
// تجزئات كلمات المرور متوافقة تمامًا مع نسخة سطح المكتب.
import { Buffer } from 'buffer';
import { scrypt as nobleScrypt, scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';

export function randomBytes(n: number): Buffer {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Buffer.from(a);
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  maxmem?: number;
}

const toU8 = (x: string | Uint8Array) => (typeof x === 'string' ? new TextEncoder().encode(x) : x);

export function scryptSync(pw: string | Uint8Array, salt: string | Uint8Array, keylen: number, o: ScryptOptions = {}): Buffer {
  return Buffer.from(nobleScrypt(toU8(pw), toU8(salt), { N: o.N ?? 16384, r: o.r ?? 8, p: o.p ?? 1, dkLen: keylen }));
}

export function scrypt(pw: string | Uint8Array, salt: string | Uint8Array, keylen: number, o: ScryptOptions, cb: (e: Error | null, key: Buffer) => void) {
  scryptAsync(toU8(pw), toU8(salt), { N: o.N ?? 16384, r: o.r ?? 8, p: o.p ?? 1, dkLen: keylen, asyncTick: 20 }).then(
    (k) => cb(null, Buffer.from(k)),
    (e) => cb(e as Error, Buffer.alloc(0)),
  );
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function createHash(alg: string) {
  if (alg.toLowerCase() !== 'sha256') throw new Error(`hash ${alg} not available`);
  const h = sha256.create();
  const api = {
    update(data: string | Uint8Array, enc?: string) {
      h.update(typeof data === 'string' ? new Uint8Array(Buffer.from(data, (enc as BufferEncoding) ?? 'utf8')) : data);
      return api;
    },
    digest(enc?: string) {
      const out = Buffer.from(h.digest());
      return enc ? out.toString(enc as BufferEncoding) : out;
    },
  };
  return api;
}

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;
export default { randomBytes, randomUUID, scryptSync, scrypt, timingSafeEqual, createHash, webcrypto, subtle };
