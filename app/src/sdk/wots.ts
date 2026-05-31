// Winternitz One-Time Signatures — TypeScript port of `crates/wots`.
//
// This MUST be byte-for-byte identical to the Rust implementation, or signatures
// produced here will not verify in the on-chain program. Parameters: Keccak-256
// truncated to 224 bits, Winternitz W=16 (base-16 nibbles), 59 chains.

import { keccak_256 } from "@noble/hashes/sha3";

export const HASH_LEN = 28; // 224-bit truncated Keccak
export const W = 16;
export const CHAIN_MAX = W - 1; // 15
export const MSG_DIGITS = HASH_LEN * 2; // 56 nibbles
export const CHECKSUM_DIGITS = 3;
export const NUM_CHAINS = MSG_DIGITS + CHECKSUM_DIGITS; // 59
export const SIGNATURE_BYTES = NUM_CHAINS * HASH_LEN; // 1652

/** Keccak-256 truncated to HASH_LEN (28) bytes. */
export function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data).slice(0, HASH_LEN);
}

/** Apply Keccak `iterations` times (walk a hash chain forward). */
function chain(input: Uint8Array, iterations: number): Uint8Array {
  let out = input;
  for (let i = 0; i < iterations; i++) out = keccak(out);
  return out;
}

/** Derive the 59 chain secrets from a 32-byte master seed: sk_i = keccak(seed || i). */
export function secretKeyFromSeed(seed: Uint8Array): Uint8Array[] {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const chains: Uint8Array[] = [];
  for (let i = 0; i < NUM_CHAINS; i++) {
    const buf = new Uint8Array(33);
    buf.set(seed, 0);
    buf[32] = i;
    chains.push(keccak(buf));
  }
  return chains;
}

/** Compressed 28-byte public key: keccak of all chain tops. */
export function publicKey(sk: Uint8Array[]): Uint8Array {
  const tops = new Uint8Array(SIGNATURE_BYTES);
  for (let i = 0; i < NUM_CHAINS; i++) {
    tops.set(chain(sk[i], CHAIN_MAX), i * HASH_LEN);
  }
  return keccak(tops);
}

/** Expand a 28-byte digest into 59 base-16 digits + 3-nibble checksum. */
function digits(messageDigest: Uint8Array): Uint8Array {
  const out = new Uint8Array(NUM_CHAINS);
  for (let i = 0; i < HASH_LEN; i++) {
    out[2 * i] = messageDigest[i] >> 4;
    out[2 * i + 1] = messageDigest[i] & 0x0f;
  }
  let checksum = 0;
  for (let i = 0; i < MSG_DIGITS; i++) checksum += CHAIN_MAX - out[i];
  out[MSG_DIGITS] = (checksum >> 8) & 0x0f;
  out[MSG_DIGITS + 1] = (checksum >> 4) & 0x0f;
  out[MSG_DIGITS + 2] = checksum & 0x0f;
  return out;
}

/** Sign `message` (one-time!). Returns the 1652-byte signature. */
export function sign(sk: Uint8Array[], message: Uint8Array): Uint8Array {
  const d = digits(keccak(message));
  const sig = new Uint8Array(SIGNATURE_BYTES);
  for (let i = 0; i < NUM_CHAINS; i++) {
    sig.set(chain(sk[i], d[i]), i * HASH_LEN);
  }
  return sig;
}

/** Verify locally (mirror of the on-chain check) — handy for tests. */
export function verify(pubkey: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== SIGNATURE_BYTES) return false;
  const d = digits(keccak(message));
  const tops = new Uint8Array(SIGNATURE_BYTES);
  for (let i = 0; i < NUM_CHAINS; i++) {
    const element = sig.slice(i * HASH_LEN, (i + 1) * HASH_LEN);
    tops.set(chain(element, CHAIN_MAX - d[i]), i * HASH_LEN);
  }
  const recovered = keccak(tops);
  return recovered.every((b, i) => b === pubkey[i]);
}
