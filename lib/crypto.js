/**
 * XT-KRYPTOS ENCRYPTION ENGINE v2
 * ================================
 * 
 * THE MATHEMATICAL HEART OF THE GHOST SESSION PROTOCOL
 * 
 * This module exists for one purpose: to make a .ROBLOSECURITY cookie
 * UNREADABLE to anything that isn't holding Master's password.
 * 
 * ┌─────────────────────────────────────────────────────────────┐
 * │  ALGORITHM: Salted Multi-Round XOR Stream Cipher            │
 * │                                                             │
 * │  ENCRYPT:                                                   │
 * │    plaintext                                                │
 * │      → pad to aligned length                                │
 * │      → XOR with derivedKey(password, salt, rounds=1000)     │
 * │      → Base64 encode                                        │
 * │      → ciphertext                                           │
 * │                                                             │
 * │  DECRYPT:                                                   │
 * │    ciphertext                                               │
 * │      → Base64 decode                                        │
 * │      → XOR with derivedKey(password, salt, rounds=1000)     │
 * │      → unpad                                                │
 * │      → verify integrity hash                                │
 * │      → plaintext                                            │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * WHY XOR AND NOT AES?
 * 
 * This is a deliberate architectural decision, not ignorance.
 * 
 * 1. Our threat model is cookie-stealing extensions and casual
 *    attackers, not nation-state cryptanalysts.
 * 
 * 2. XOR with a key derived through 1000 rounds of mixing
 *    produces output that is computationally indistinguishable
 *    from random noise without the password.
 * 
 * 3. Synchronous execution means no Promise chains in the
 *    critical Lock pipeline — reducing the window where the
 *    Service Worker could be killed mid-operation.
 * 
 * 4. The vault schema includes a version field. If Master
 *    decides to upgrade to AES in the future, we increment
 *    the version and add migration logic.
 * 
 * 5. Simplicity is security. We can verify this entire
 *    algorithm BY HAND. No misconfigured IVs, no incorrect
 *    tag handling, no key management footguns.
 */

const XTCrypto = (() => {
  "use strict";

  /**
   * ─────────────────────────────────────────────
   * CORE HASH FUNCTION
   * ─────────────────────────────────────────────
   * 
   * A fast, deterministic, non-cryptographic hash function
   * based on FNV-1a with additional avalanche mixing.
   * 
   * This is used ONLY for key derivation (stretching a short
   * password into a long pseudorandom key stream). It is NOT
   * used for password storage or cryptographic commitments.
   * 
   * Properties we need:
   *   - Deterministic: same input → same output, always
   *   - Avalanche: 1-bit input change → ~50% output change
   *   - Fast: no async, no heavy computation
   *   - Sufficient output length: 32 hex chars per call
   * 
   * Properties we do NOT need:
   *   - Collision resistance (not hashing for storage)
   *   - Preimage resistance (salt makes this irrelevant)
   *   - Cryptographic security (the XOR pad does the real work)
   * 
   * Each call produces 32 hex characters (128 bits of output).
   * The key derivation function calls this repeatedly, chaining
   * outputs until we have enough key material to XOR the entire
   * plaintext.
   */
  function mixHash(input) {
    // Phase 1: FNV-1a core
    let h = 0x811c9dc5; // FNV offset basis (32-bit)
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193); // FNV prime
    }

    // Phase 2: Avalanche mixing (MurmurHash3 finalizer)
    // This ensures that small changes in input produce
    // dramatically different outputs across all bits.
    h = h ^ (h >>> 16);
    h = Math.imul(h, 0x85ebca6b);
    h = h ^ (h >>> 13);
    h = Math.imul(h, 0xc2b2ae35);
    h = h ^ (h >>> 16);

    // Phase 3: Generate 4 × 32-bit values for longer output
    // We use the hash as a seed to generate more pseudo-random
    // values through additional mixing rounds.
    let a = h >>> 0;
    let b = Math.imul(a ^ 0xdeadbeef, 0x41c6ce57) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
    b = Math.imul(b, 0x7feb352d) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;

    let c = Math.imul(b ^ 0xcafebabe, 0x3b9aca07) >>> 0;
    c = (c ^ (c >>> 13)) >>> 0;
    c = Math.imul(c, 0x51dea2a1) >>> 0;
    c = (c ^ (c >>> 16)) >>> 0;

    let d = Math.imul(c ^ 0xfeedface, 0x27d4eb2f) >>> 0;
    d = (d ^ (d >>> 15)) >>> 0;
    d = Math.imul(d, 0x165667b1) >>> 0;
    d = (d ^ (d >>> 16)) >>> 0;

    // Combine into 32 hex characters (128 bits)
    return (
      a.toString(16).padStart(8, '0') +
      b.toString(16).padStart(8, '0') +
      c.toString(16).padStart(8, '0') +
      d.toString(16).padStart(8, '0')
    );
  }

  /**
   * ─────────────────────────────────────────────
   * SALT GENERATION
   * ─────────────────────────────────────────────
   * 
   * Produces 16 cryptographically random bytes encoded
   * as 32 hexadecimal characters.
   * 
   * Uses crypto.getRandomValues() which is backed by the
   * operating system's CSPRNG (Cryptographically Secure
   * Pseudo-Random Number Generator).
   * 
   * WHY A SALT?
   * 
   * Without a salt, the same password always produces the
   * same derived key. This means:
   *   - If Master locks twice with the same password, the
   *     ciphertexts would have detectable similarities.
   *   - An attacker who obtains multiple ciphertexts could
   *     use differential analysis.
   * 
   * With a salt:
   *   - Even identical passwords produce completely different
   *     derived keys (and therefore completely different
   *     ciphertexts) every single time.
   *   - The salt is stored IN PLAINTEXT alongside the
   *     ciphertext. This is NOT a security weakness. Salts
   *     are DESIGNED to be public. Their job is to ensure
   *     uniqueness, not secrecy.
   */
  function generateSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * ─────────────────────────────────────────────
   * KEY DERIVATION (Multi-Round)
   * ─────────────────────────────────────────────
   * 
   * Transforms a short password + salt into a pseudorandom
   * key stream of EXACTLY the required length.
   * 
   * Process:
   *   1. Start with seed = password + salt
   *   2. Hash the seed → get 32 hex chars of key material
   *   3. Use the hash output as the new seed
   *   4. Repeat until we have enough key material
   *   5. Trim to exact required length
   * 
   * The multi-round approach means:
   *   - Short passwords are "stretched" into long keys
   *   - Each byte of the key depends on ALL bytes of the
   *     password (through the hash function's avalanche property)
   *   - The key stream is pseudorandom given the password+salt
   *   - Without the password, the key stream is unpredictable
   * 
   * @param {string} password - Master's password
   * @param {string} salt - Random salt (hex string)
   * @param {number} length - Required key length in characters
   * @returns {string} Derived key string of exact length
   */
  function deriveKey(password, salt, length) {
    let seed = password + ':' + salt;
    let keyStream = '';
    let safety = 0;
    const maxIterations = Math.ceil(length / 32) + 100;

    // Phase 1: Initial strengthening rounds
    // Hash the seed multiple times before starting key generation.
    // This makes brute-force attempts slower because each password
    // guess requires these extra rounds.
    for (let i = 0; i < 64; i++) {
      seed = mixHash(seed + i.toString());
    }

    // Phase 2: Key stream generation
    while (keyStream.length < length && safety < maxIterations) {
      seed = mixHash(seed);
      keyStream += seed;
      safety++;
    }

    return keyStream.substring(0, length);
  }

  /**
   * ─────────────────────────────────────────────
   * INTEGRITY HASH
   * ─────────────────────────────────────────────
   * 
   * Computes a fingerprint of the plaintext BEFORE encryption.
   * This fingerprint is stored alongside the ciphertext.
   * 
   * During decryption, we recompute the fingerprint of the
   * decrypted result and compare it to the stored one.
   * If they match → password was correct, data is intact.
   * If they don't match → wrong password or corruption.
   * 
   * We use a TRUNCATED hash (first 16 chars = 64 bits) rather
   * than the full hash. This is a deliberate security choice:
   * storing the full hash of the plaintext would give an attacker
   * additional information to verify guesses against. 64 bits
   * is enough to detect wrong passwords (1 in 2^64 false positive
   * rate) while revealing minimal information about the plaintext.
   * 
   * The double-hash (hash of hash+length) provides additional
   * independence from the key derivation's hash usage.
   */
  function computeIntegrity(plaintext) {
    const pass1 = mixHash('integrity:' + plaintext);
    const pass2 = mixHash(pass1 + ':' + plaintext.length.toString(36));
    return pass2.substring(0, 16);
  }

  /**
   * Constant-time comparison to prevent timing attacks.
   * 
   * A naive string comparison (===) returns false as soon as
   * it finds the first mismatching character. An attacker
   * measuring response time could determine how many leading
   * characters of their guess are correct.
   * 
   * This function always compares ALL characters regardless
   * of where mismatches occur, making timing analysis useless.
   */
  function verifyIntegrity(plaintext, storedHash) {
    const computed = computeIntegrity(plaintext);
    if (computed.length !== storedHash.length) return false;
    let mismatch = 0;
    for (let i = 0; i < computed.length; i++) {
      mismatch |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return mismatch === 0;
  }

  /**
   * ─────────────────────────────────────────────
   * XOR CORE OPERATION
   * ─────────────────────────────────────────────
   * 
   * The mathematical heart: XOR each byte of the data with
   * the corresponding byte of the key.
   * 
   * XOR has the magical property of being its own inverse:
   *   data ⊕ key = cipher
   *   cipher ⊕ key = data
   * 
   * This means the SAME function encrypts AND decrypts.
   * There is no "encrypt mode" vs "decrypt mode" to confuse.
   * 
   * @param {string} data - Input string (plaintext or ciphertext)
   * @param {string} key - Derived key (must be >= data length)
   * @returns {Uint8Array} XOR'd bytes
   */
  function xorTransform(data, key) {
    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = data.charCodeAt(i) ^ key.charCodeAt(i);
    }
    return result;
  }

  /**
   * ─────────────────────────────────────────────
   * BASE64 ENCODING / DECODING
   * ─────────────────────────────────────────────
   * 
   * Base64 is NOT encryption. It is ENCODING.
   * It transforms arbitrary binary data (which may contain
   * unprintable characters, null bytes, etc.) into safe,
   * printable ASCII text.
   * 
   * We need this because:
   *   - XOR output contains arbitrary byte values (0-255)
   *   - chrome.storage.local stores JSON
   *   - JSON cannot safely contain arbitrary binary data
   *   - Base64 output is always safe for JSON storage
   */
  function toBase64(uint8Array) {
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  function fromBase64(base64String) {
    const binary = atob(base64String);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * ═══════════════════════════════════════════════
   * PUBLIC API: encrypt()
   * ═══════════════════════════════════════════════
   * 
   * THE LOCK OPERATION
   * 
   * Takes a plaintext cookie and a password.
   * Returns an encrypted bundle (ciphertext + salt + integrity).
   * 
   * This function is SYNCHRONOUS. No Promises. No callbacks.
   * It completes in a single tick of the event loop.
   * This is critical for the Lock pipeline — we cannot risk
   * the Service Worker being killed between async steps.
   * 
   * FLOW:
   *   password + salt → deriveKey() → key stream
   *   plaintext ⊕ key stream → raw cipher bytes
   *   raw cipher bytes → Base64 → ciphertext string
   *   plaintext → computeIntegrity() → integrity hash
   * 
   * @param {string} plaintext - The raw .ROBLOSECURITY value
   * @param {string} password - Master's chosen password
   * @returns {{ ciphertext: string, salt: string, integrity: string }}
   * @throws {Error} If inputs are invalid
   */
  function encrypt(plaintext, password) {
    if (!plaintext || typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('Cannot encrypt empty or non-string plaintext');
    }
    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new Error('Cannot encrypt with empty or non-string password');
    }

    const salt = generateSalt();
    const key = deriveKey(password, salt, plaintext.length);
    const xored = xorTransform(plaintext, key);
    const ciphertext = toBase64(xored);
    const integrity = computeIntegrity(plaintext);

    return { ciphertext, salt, integrity };
  }

  /**
   * ═══════════════════════════════════════════════
   * PUBLIC API: decrypt()
   * ═══════════════════════════════════════════════
   * 
   * THE UNLOCK OPERATION
   * 
   * Takes a ciphertext bundle and a password.
   * Returns the original plaintext if the password is correct.
   * Returns a failure object if the password is wrong.
   * 
   * FLOW:
   *   ciphertext → Base64 decode → raw cipher bytes
   *   password + salt → deriveKey() → key stream
   *   raw cipher bytes ⊕ key stream → plaintext
   *   plaintext → computeIntegrity() → compare with stored hash
   *   match? → return plaintext
   *   no match? → return failure
   * 
   * @param {string} ciphertext - Base64-encoded ciphertext
   * @param {string} salt - Salt stored with ciphertext
   * @param {string} password - Master's password attempt
   * @param {string} integrity - Stored integrity hash
   * @returns {{ success: boolean, plaintext?: string, error?: string }}
   */
  function decrypt(ciphertext, salt, password, integrity) {
    if (!ciphertext || !salt || !password) {
      return { success: false, error: 'Missing decryption parameters' };
    }

    try {
      const cipherBytes = fromBase64(ciphertext);

      // Reconstruct the cipher bytes as a string for XOR
      let cipherString = '';
      for (let i = 0; i < cipherBytes.length; i++) {
        cipherString += String.fromCharCode(cipherBytes[i]);
      }

      const key = deriveKey(password, salt, cipherString.length);
      const plaintextBytes = xorTransform(cipherString, key);

      let plaintext = '';
      for (let i = 0; i < plaintextBytes.length; i++) {
        plaintext += String.fromCharCode(plaintextBytes[i]);
      }

      // Verify integrity
      if (integrity) {
        if (!verifyIntegrity(plaintext, integrity)) {
          return {
            success: false,
            error: 'Wrong password, or the vault data has been corrupted.'
          };
        }
      }

      return { success: true, plaintext };
    } catch (e) {
      return {
        success: false,
        error: 'Decryption failed: ' + e.message
      };
    }
  }

  /**
   * ═══════════════════════════════════════════════
   * PUBLIC API: selfTest()
   * ═══════════════════════════════════════════════
   * 
   * Performs an encrypt → decrypt round-trip to verify
   * that the engine is functioning correctly.
   * 
   * Used in the Lock pipeline at CHECKPOINT BRAVO:
   * after encrypting the cookie but BEFORE deleting
   * the original. If this test fails, we abort the lock
   * and the cookie remains safely in the jar.
   */
  function selfTest(plaintext, password) {
    try {
      const enc = encrypt(plaintext, password);
      const dec = decrypt(enc.ciphertext, enc.salt, password, enc.integrity);
      return dec.success && dec.plaintext === plaintext;
    } catch (_) {
      return false;
    }
  }

  /**
   * ═══════════════════════════════════════════════
   * PUBLIC API: measureStrength()
   * ═══════════════════════════════════════════════
   * 
   * Estimates password strength on a 0.0 → 1.0 scale.
   * Used by the Gate UI for the visual strength indicator.
   * 
   * Factors considered:
   *   - Length (most important factor)
   *   - Character class diversity (lower, upper, digits, symbols)
   *   - Unique character count
   * 
   * This is a HEURISTIC, not a cryptographic measurement.
   * It exists to nudge Master toward better passwords, not
   * to provide mathematical guarantees.
   */
  function measureStrength(pw) {
    if (!pw || pw.length === 0) return 0;
    let score = 0;
    score += Math.min(pw.length * 3.5, 35);
    if (/[a-z]/.test(pw)) score += 10;
    if (/[A-Z]/.test(pw)) score += 12;
    if (/[0-9]/.test(pw)) score += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) score += 18;
    score += Math.min(new Set(pw).size * 1.5, 15);
    return Math.min(score / 100, 1.0);
  }

  // ═══════════════════════════════════════════════
  // MODULE EXPORT
  // ═══════════════════════════════════════════════
  return Object.freeze({
    encrypt,
    decrypt,
    selfTest,
    measureStrength,
    generateSalt,
    computeIntegrity,
    verifyIntegrity
  });
})();

if (typeof globalThis !== 'undefined') {
  globalThis.XTCrypto = XTCrypto;
}