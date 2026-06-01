/**
 * XT-KRYPTOS VAULT MANAGER v2
 * =============================
 * 
 * THE FILING CABINET
 * 
 * The Vault is a DUMB storage container. It has no logic.
 * It has no validation. It has no encryption capability.
 * It simply holds whatever the Guardian writes and returns
 * whatever the Guardian reads.
 * 
 * The intelligence lives in the Guardian.
 * The Vault is merely the Guardian's filing cabinet.
 * 
 * ┌─────────────────────────────────────────────────────┐
 * │  VAULT DATA SCHEMA (v2)                             │
 * │                                                     │
 * │  KEY: "xt_kryptos_vault"                            │
 * │  VALUE: {                                           │
 * │    version: 2,           // Schema version          │
 * │    ciphertext: "a7Fx...",// Encrypted cookie        │
 * │    salt: "3f8c...",      // Random salt             │
 * │    integrity: "9e2a...", // Truncated plaintext hash│
 * │    lockedAt: 17089...,   // Unix timestamp (ms)     │
 * │    cookieMeta: {         // Original cookie attrs   │
 * │      domain, path, secure, httpOnly,                │
 * │      sameSite, expirationDate, hostOnly, storeId    │
 * │    }                                                │
 * │  }                                                  │
 * │                                                     │
 * │  STATE KEY: "xt_kryptos_state"                      │
 * │  STATE VALUES: "EMPTY" | "LOCKED" | "UNLOCKED"     │
 * │                                                     │
 * │  RULE KEY: "xt_kryptos_ghost_active"                │
 * │  RULE VALUE: true | false                           │
 * └─────────────────────────────────────────────────────┘
 * 
 * STORAGE LAYERS:
 * 
 * chrome.storage.local  — PERMANENT storage
 *   Survives everything: worker sleep, browser restart,
 *   system reboot. This is where the encrypted vault lives.
 *   If Chrome is uninstalled, this data is destroyed.
 * 
 * chrome.storage.session — SESSION storage
 *   Survives Service Worker sleep cycles but dies on
 *   browser close. Used for the state flag and ghost
 *   session tracking. This means: closing Chrome
 *   automatically locks the vault (state flag is lost,
 *   Guardian resolves to LOCKED on next startup).
 */

const Vault = (() => {
  "use strict";

  const VAULT_KEY = 'xt_kryptos_vault';
  const STATE_KEY = 'xt_kryptos_state';
  const GHOST_KEY = 'xt_kryptos_ghost_active';
  const SCHEMA_VERSION = 2;

  // ─────────────────────────────────────────────
  // VAULT DATA (chrome.storage.local)
  // ─────────────────────────────────────────────

  /**
   * Read the vault contents.
   * Returns the vault object or null if empty.
   */
  async function read() {
    const result = await chrome.storage.local.get(VAULT_KEY);
    return result[VAULT_KEY] || null;
  }

  /**
   * Write data to the vault.
   * Includes a read-back verification to ensure the write
   * actually persisted correctly.
   * 
   * @param {Object} data - Vault data object
   * @throws {Error} If write verification fails
   */
  async function write(data) {
    data.version = SCHEMA_VERSION;
    await chrome.storage.local.set({ [VAULT_KEY]: data });

    // Read-back verification
    const verify = await read();
    if (!verify || verify.ciphertext !== data.ciphertext) {
      throw new Error('Vault write verification failed — data may not have persisted');
    }
  }

  /**
   * Check if the vault contains data.
   */
  async function exists() {
    const data = await read();
    return data !== null && data.ciphertext !== undefined;
  }

  /**
   * Permanently destroy all vault data.
   */
  async function destroy() {
    await chrome.storage.local.remove(VAULT_KEY);
  }

  // ─────────────────────────────────────────────
  // SESSION STATE (chrome.storage.session)
  // ─────────────────────────────────────────────

  /**
   * Get the current state flag.
   * Returns "EMPTY", "LOCKED", "UNLOCKED", or null.
   */
  async function getState() {
    const result = await chrome.storage.session.get(STATE_KEY);
    return result[STATE_KEY] || null;
  }

  /**
   * Set the state flag.
   */
  async function setState(state) {
    await chrome.storage.session.set({ [STATE_KEY]: state });
  }

  /**
   * Track whether the ghost session is active.
   */
  async function setGhostActive(active) {
    await chrome.storage.session.set({ [GHOST_KEY]: active });
  }

  async function isGhostActive() {
    const result = await chrome.storage.session.get(GHOST_KEY);
    return result[GHOST_KEY] === true;
  }

  /**
   * Clear all session data.
   */
  async function clearSession() {
    await chrome.storage.session.clear();
  }

  /**
   * Nuclear option: clear everything (vault + session).
   */
  async function obliterate() {
    await chrome.storage.local.remove(VAULT_KEY);
    await chrome.storage.session.clear();
  }

  // ═══════════════════════════════════════════════
  // MODULE EXPORT
  // ═══════════════════════════════════════════════
  return Object.freeze({
    read,
    write,
    exists,
    destroy,
    getState,
    setState,
    setGhostActive,
    isGhostActive,
    clearSession,
    obliterate,
    SCHEMA_VERSION
  });
})();

if (typeof globalThis !== 'undefined') {
  globalThis.Vault = Vault;
}