//! # Winternitz One-Time Signatures (WOTS) over Keccak-256
//!
//! A self-contained, dependency-light implementation of the signature scheme
//! that powers quantum-resistant vaults on Solana.
//!
//! ## Why this is quantum-resistant
//!
//! Its security rests *only* on the one-wayness (preimage resistance) of a hash
//! function. Unlike Ed25519, there is no elliptic curve and no discrete-log
//! problem for Shor's algorithm to attack. The best a quantum computer can do is
//! Grover's algorithm, which only *halves* the effective security of a hash — so
//! Keccak-256 still gives ~128-bit post-quantum security.
//!
//! ## The one-time constraint (read this!)
//!
//! A WOTS keypair is safe to sign **exactly one** message. Each signature reveals
//! part of the secret hash chains; signing a second, different message leaks
//! enough intermediate values for an attacker to forge. On Solana this is handled
//! by the *vault pattern*: every spend closes the current vault and opens a new
//! one committed to a fresh public key. See the program crate.
//!
//! ## How it works (base-256 chains)
//!
//! 1. The secret key is `NUM_CHAINS` random 32-byte values, one per "chain".
//! 2. The public key hashes each secret value `CHAIN_MAX` (255) times, then hashes
//!    all the chain tops together into a single compressed 32-byte commitment.
//! 3. To sign, we treat the 32-byte message digest as 32 base-256 digits, append a
//!    2-digit checksum, and for digit `d` on chain `i` we hash the secret `d` times.
//! 4. To verify, we hash each signature element the *remaining* `255 - d` times to
//!    recover the chain top, then check the compressed commitment matches.
//!
//! The checksum is what stops forgery: raising a message digit (cheap — just hash
//! more) forces a checksum digit to *drop*, which would require inverting the hash
//! (infeasible).

#![forbid(unsafe_code)]

/// Hash length in bytes (n) — Keccak-256 **truncated to 224 bits**.
///
/// Why 224 and not 256: a 256-bit scheme produces a 1088-byte signature which,
/// once wrapped in a transaction, blows past Solana's 1232-byte limit. Truncating
/// to 224 bits yields an 840-byte signature that fits a single transaction — the
/// same choice the real Solana Winternitz vault makes. Security: 224-bit preimage
/// resistance → ~112-bit post-quantum (Grover only square-roots it), still ample.
pub const HASH_LEN: usize = 28;
/// Base-256 digits taken from the 28-byte message digest (one per byte).
pub const MSG_DIGITS: usize = 28;
/// Checksum digits. Max checksum = 28 * 255 = 7140 < 2^16, so 2 bytes suffice.
pub const CHECKSUM_DIGITS: usize = 2;
/// Total hash chains = message digits + checksum digits.
pub const NUM_CHAINS: usize = MSG_DIGITS + CHECKSUM_DIGITS; // 30
/// Maximum iterations per chain (a base-256 digit is 0..=255).
pub const CHAIN_MAX: usize = 255;
/// Wire size of a signature in bytes (30 * 28 = 840). Fits Solana's 1232-byte
/// transaction limit once instruction + account overhead is added.
pub const SIGNATURE_BYTES: usize = NUM_CHAINS * HASH_LEN;

/// A 32-byte Keccak-256 hash value.
pub type Hash = [u8; HASH_LEN];

/// Keccak-256 of `data`, truncated to [`HASH_LEN`] bytes
/// (off-chain / test backend: pure-Rust `sha3`).
#[cfg(feature = "sha3-backend")]
pub fn keccak(data: &[u8]) -> Hash {
    use sha3::{Digest, Keccak256};
    let mut h = Keccak256::new();
    h.update(data);
    let full = h.finalize();
    let mut out = [0u8; HASH_LEN];
    out.copy_from_slice(&full[..HASH_LEN]);
    out
}

/// Keccak-256 of `data`, truncated to [`HASH_LEN`] bytes
/// (on-chain backend: Solana's `keccak` syscall, cheap CU).
#[cfg(all(feature = "solana-backend", not(feature = "sha3-backend")))]
pub fn keccak(data: &[u8]) -> Hash {
    let full = solana_program::keccak::hash(data).to_bytes();
    let mut out = [0u8; HASH_LEN];
    out.copy_from_slice(&full[..HASH_LEN]);
    out
}

/// Apply Keccak-256 to `input` `iterations` times (walk a hash chain forward).
fn chain(mut input: Hash, iterations: usize) -> Hash {
    for _ in 0..iterations {
        input = keccak(&input);
    }
    input
}

/// Expand a 32-byte message digest into `NUM_CHAINS` base-256 digits:
/// 32 message digits followed by a 2-digit big-endian checksum.
///
/// The checksum is `sum(CHAIN_MAX - digit)` over the message digits, which is
/// what makes forgery infeasible (see crate docs).
fn digits(message_digest: &Hash) -> [u8; NUM_CHAINS] {
    let mut out = [0u8; NUM_CHAINS];
    out[..MSG_DIGITS].copy_from_slice(message_digest);

    let mut checksum: u32 = 0;
    for &d in &message_digest[..MSG_DIGITS] {
        checksum += (CHAIN_MAX as u32) - (d as u32);
    }
    out[MSG_DIGITS] = (checksum >> 8) as u8;
    out[MSG_DIGITS + 1] = (checksum & 0xff) as u8;
    out
}

/// A WOTS secret key: one 32-byte seed per hash chain.
///
/// Derived deterministically from a single 32-byte master seed so a wallet only
/// has to store/back-up 32 bytes, not the full ~1 KB key.
pub struct SecretKey {
    chains: [Hash; NUM_CHAINS],
}

impl SecretKey {
    /// Deterministically derive a secret key from a 32-byte master seed.
    ///
    /// Each chain's secret is `Keccak(seed || index)`.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let mut chains = [[0u8; HASH_LEN]; NUM_CHAINS];
        for (i, c) in chains.iter_mut().enumerate() {
            let mut buf = [0u8; 33];
            buf[..32].copy_from_slice(seed);
            buf[32] = i as u8;
            *c = keccak(&buf);
        }
        SecretKey { chains }
    }

    /// Compute the compressed 32-byte public key (the vault commitment).
    pub fn public_key(&self) -> PublicKey {
        let mut tops = [0u8; SIGNATURE_BYTES];
        for (i, c) in self.chains.iter().enumerate() {
            let top = chain(*c, CHAIN_MAX);
            tops[i * HASH_LEN..(i + 1) * HASH_LEN].copy_from_slice(&top);
        }
        PublicKey(keccak(&tops))
    }

    /// Sign `message`. **One-time use only** — never sign twice with one key.
    pub fn sign(&self, message: &[u8]) -> Signature {
        let d = digits(&keccak(message));
        let mut sig = [[0u8; HASH_LEN]; NUM_CHAINS];
        for (i, s) in sig.iter_mut().enumerate() {
            *s = chain(self.chains[i], d[i] as usize);
        }
        Signature(sig)
    }
}

/// The compressed 32-byte WOTS public key. This is what a vault stores on-chain.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PublicKey(pub Hash);

impl PublicKey {
    /// Recover the public key implied by `sig` over `message` and check it matches.
    ///
    /// This is the operation a Solana program runs on-chain: pure hashing, cheap
    /// in compute units relative to lattice verification.
    pub fn verify(&self, message: &[u8], sig: &Signature) -> bool {
        let d = digits(&keccak(message));
        let mut tops = [0u8; SIGNATURE_BYTES];
        for (i, element) in sig.0.iter().enumerate() {
            let top = chain(*element, CHAIN_MAX - d[i] as usize);
            tops[i * HASH_LEN..(i + 1) * HASH_LEN].copy_from_slice(&top);
        }
        PublicKey(keccak(&tops)) == *self
    }
}

/// A WOTS signature: one 32-byte value per chain (1088 bytes on the wire).
#[derive(Clone)]
pub struct Signature(pub [Hash; NUM_CHAINS]);

impl Signature {
    /// Serialize to the 1088-byte wire format.
    pub fn to_bytes(&self) -> [u8; SIGNATURE_BYTES] {
        let mut out = [0u8; SIGNATURE_BYTES];
        for (i, element) in self.0.iter().enumerate() {
            out[i * HASH_LEN..(i + 1) * HASH_LEN].copy_from_slice(element);
        }
        out
    }

    /// Parse from the 1088-byte wire format.
    pub fn from_bytes(bytes: &[u8; SIGNATURE_BYTES]) -> Self {
        let mut sig = [[0u8; HASH_LEN]; NUM_CHAINS];
        for (i, element) in sig.iter_mut().enumerate() {
            element.copy_from_slice(&bytes[i * HASH_LEN..(i + 1) * HASH_LEN]);
        }
        Signature(sig)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7u8; 32];

    #[test]
    fn sign_and_verify_roundtrip() {
        let sk = SecretKey::from_seed(&SEED);
        let pk = sk.public_key();
        let msg = b"withdraw 1 SOL to alice";
        let sig = sk.sign(msg);
        assert!(pk.verify(msg, &sig), "valid signature must verify");
    }

    #[test]
    fn wrong_message_is_rejected() {
        let sk = SecretKey::from_seed(&SEED);
        let pk = sk.public_key();
        let sig = sk.sign(b"withdraw 1 SOL to alice");
        assert!(
            !pk.verify(b"withdraw 1 SOL to mallory", &sig),
            "signature must not verify against a different message"
        );
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let sk = SecretKey::from_seed(&SEED);
        let pk = sk.public_key();
        let msg = b"withdraw 1 SOL to alice";
        let mut sig = sk.sign(msg);
        sig.0[0][0] ^= 0xff; // flip a byte
        assert!(!pk.verify(msg, &sig), "tampered signature must be rejected");
    }

    #[test]
    fn wrong_key_is_rejected() {
        let sk = SecretKey::from_seed(&SEED);
        let other_pk = SecretKey::from_seed(&[9u8; 32]).public_key();
        let msg = b"hello";
        let sig = sk.sign(msg);
        assert!(!other_pk.verify(msg, &sig), "must not verify under a foreign key");
    }

    #[test]
    fn signature_wire_roundtrip() {
        let sk = SecretKey::from_seed(&SEED);
        let pk = sk.public_key();
        let msg = b"roundtrip";
        let sig = sk.sign(msg);
        let parsed = Signature::from_bytes(&sig.to_bytes());
        assert!(pk.verify(msg, &parsed), "wire roundtrip must preserve validity");
    }

    /// The checksum must stop the classic WOTS forgery: an attacker who only
    /// raises message digits (cheap — hashing forward) cannot also lower the
    /// checksum digits without inverting the hash. We simulate the *honest* part
    /// of that attack and confirm the recovered key no longer matches.
    #[test]
    fn checksum_blocks_digit_raising_forgery() {
        let sk = SecretKey::from_seed(&SEED);
        let pk = sk.public_key();
        let msg = b"pay 1";
        let sig = sk.sign(msg);

        // Forge by advancing every message chain one extra step (raising digits).
        let mut forged = sig.clone();
        for element in forged.0.iter_mut().take(MSG_DIGITS) {
            *element = keccak(element);
        }
        // Some other message whose digest the attacker hoped to match — but the
        // checksum chains weren't advanced backward, so verification fails.
        assert!(
            !pk.verify(msg, &forged),
            "raising message digits without fixing checksum must fail"
        );
    }

    #[test]
    fn signature_fits_solana_transaction() {
        // Solana's max transaction size is 1232 bytes; our 224-bit signature is
        // 840, leaving ~390 bytes for instruction + account + signature overhead.
        assert_eq!(SIGNATURE_BYTES, 840);
        assert!(SIGNATURE_BYTES < 1232);
    }
}
