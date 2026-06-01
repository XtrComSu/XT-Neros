/**
 * XT-KRYPTOS — THE GUARDIAN v2
 * ==============================
 * 
 * THE CENTRAL NERVOUS SYSTEM
 * 
 * ┌──────────────────────────────────────────────────────────────┐
 * │                    TRUST HIERARCHY                           │
 * │                                                              │
 * │  LEVEL 4 — MAXIMUM TRUST: THE GUARDIAN (this file)           │
 * │    ► Sees plaintext during operations                        │
 * │    ► Has all Chrome API access                               │
 * │    ► Makes all decisions                                     │
 * │    ► Is the ONLY component that touches secrets              │
 * │                                                              │
 * │  LEVEL 3 — HIGH TRUST: THE VAULT                             │
 * │    ► Holds encrypted data                                    │
 * │    ► Cannot decrypt on its own                               │
 * │    ► Is "trusted with the lockbox but not the key"           │
 * │                                                              │
 * │  LEVEL 2 — MEDIUM TRUST: THE WHISPERER (Ghost Protocol)     │
 * │    ► Handles plaintext in transit (network headers)          │
 * │    ► Cannot store, log, or redirect the data                 │
 * │    ► Is a "courier" — carries the message, can't exfiltrate  │
 * │                                                              │
 * │  LEVEL 1 — MINIMAL TRUST: THE GATE (Popup UI)               │
 * │    ► Sees Master's password briefly (input field)            │
 * │    ► Immediately sends it here and forgets                   │
 * │    ► Never sees the cookie, never sees ciphertext            │
 * │    ► Is the "receptionist" — takes your name, doesn't        │
 * │      know what's in the vault                                │
 * └──────────────────────────────────────────────────────────────┘
 * 
 * SERVICE WORKER EPHEMERALITY:
 * 
 * In Manifest V3, this Service Worker is EPHEMERAL. Chrome may
 * terminate it after ~30 seconds of inactivity. When an event
 * arrives (message, alarm), Chrome re-instantiates it.
 * 
 * Consequences:
 *   1. No in-memory state survives sleep → use chrome.storage
 *   2. Initialization must be idempotent → full state resolution
 *   3. Long operations are risky → sequence carefully
 * 
 * Every time the Guardian wakes, it reconstructs its full
 * operational context from storage. It never assumes "I already
 * did this setup step earlier."
 */

// ─────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────
importScripts('lib/crypto.js', 'lib/ghost.js', 'lib/vault.js');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const ALARM_AUTO_RELOCK = 'xt_kryptos_auto_relock';
const DEFAULT_TIMEOUT_MINUTES = 30;

const STATE = Object.freeze({
  EMPTY: 'EMPTY',
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED'
});

// ═══════════════════════════════════════════════════════════════
// STATE RESOLUTION ENGINE
// ═══════════════════════════════════════════════════════════════
//
// The Guardian must always know the AUTHORITATIVE state of the
// system, even after unexpected shutdowns, browser crashes, or
// partial operation failures.
//
// The state is derived from THREE independent sources of truth:
//   1. Session flag (chrome.storage.session) — what we THINK the state is
//   2. Vault data (chrome.storage.local) — whether encrypted data EXISTS
//   3. Ghost rules (declarativeNetRequest) — whether injection is ACTIVE
//
// These three signals can be INCONSISTENT (e.g., session flag says
// UNLOCKED but rules were cleared by Chrome). The resolution engine
// reconciles all three into a single, correct state.
//
// DECISION TREE:
//
//   Session says UNLOCKED?
//     └─ Ghost rules exist? → genuinely UNLOCKED ✓
//     └─ No rules? → STALE FLAG
//        └─ Vault has data? → LOCKED
//        └─ No vault data? → EMPTY
//
//   Session says LOCKED?
//     └─ Vault has data? → genuinely LOCKED ✓ (clean orphan rules)
//     └─ No vault data? → INCONSISTENT → EMPTY
//
//   Session says EMPTY?
//     └─ Vault has data? → INCONSISTENT → LOCKED
//     └─ No vault data? → genuinely EMPTY ✓ (clean orphan rules)
//
//   No session flag (first run / cleared)?
//     └─ Vault has data? → LOCKED (clean orphan rules)
//     └─ No vault data? → EMPTY (clean orphan rules)
//
// ═══════════════════════════════════════════════════════════════

async function resolveState() {
  const [sessionState, vaultExists, ghostActive] = await Promise.all([
    Vault.getState(),
    Vault.exists(),
    GhostProtocol.isActive()
  ]);

  let resolvedState;

  if (sessionState === STATE.UNLOCKED) {
    if (ghostActive) {
      resolvedState = STATE.UNLOCKED;
    } else {
      // Stale UNLOCKED flag — ghost rules gone
      resolvedState = vaultExists ? STATE.LOCKED : STATE.EMPTY;
      if (!vaultExists) await cleanupOrphanedState();
    }
  } else if (sessionState === STATE.LOCKED) {
    if (vaultExists) {
      resolvedState = STATE.LOCKED;
      // Clean up orphaned ghost rules if any
      if (ghostActive) await GhostProtocol.deactivate();
    } else {
      resolvedState = STATE.EMPTY;
    }
  } else if (sessionState === STATE.EMPTY) {
    if (vaultExists) {
      resolvedState = STATE.LOCKED;
      if (ghostActive) await GhostProtocol.deactivate();
    } else {
      resolvedState = STATE.EMPTY;
      if (ghostActive) await GhostProtocol.deactivate();
    }
  } else {
    // No session flag — first run or session was cleared
    if (vaultExists) {
      resolvedState = STATE.LOCKED;
    } else {
      resolvedState = STATE.EMPTY;
    }
    // Always clean orphaned ghost rules on fresh state
    if (ghostActive) await GhostProtocol.deactivate();
  }

  // Persist resolved state
  await Vault.setState(resolvedState);
  return resolvedState;
}

/**
 * Fast path: Read session flag directly.
 * Falls back to full resolution if flag is missing or suspicious.
 */
async function fastStateCheck() {
  const flag = await Vault.getState();
  if (flag && Object.values(STATE).includes(flag)) {
    return flag;
  }
  return resolveState();
}

/**
 * Clean up all ephemeral state (ghost rules, alarms, session flags).
 */
async function cleanupOrphanedState() {
  await GhostProtocol.deactivate();
  await Vault.setGhostActive(false);
  try { await chrome.alarms.clear(ALARM_AUTO_RELOCK); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 1: LOCK
// ═══════════════════════════════════════════════════════════════
//
// The most critical and most dangerous pipeline.
// It involves DESTRUCTIVE operations (deleting the cookie)
// that are IRREVERSIBLE if something goes wrong mid-pipeline.
//
// CHECKPOINT-AND-ROLLBACK ARCHITECTURE:
//
//   STEP 1 (VALIDATE) → can abort cleanly
//   STEP 2 (SNATCH)   → cookie in memory | abort = nothing lost
//       ▼ CHECKPOINT ALPHA
//   STEP 3 (ENCRYPT)  → ciphertext in memory | abort = nothing lost
//   STEP 4 (VERIFY)   → round-trip test | abort = nothing lost
//       ▼ CHECKPOINT BRAVO
//   STEP 5 (STORE)    → ciphertext in vault | abort = cookie still in jar
//       ▼ CHECKPOINT CHARLIE
//   STEP 6 (SCRUB)    → cookie deleted from jar
//       ▼ CHECKPOINT DELTA
//   STEP 7 (CONFIRM)  → state updated, plaintext nulled
//
//   If failure at STEP 3-4: Nothing stored, nothing deleted. Clean.
//   If failure at STEP 5: Cookie still in jar. Clean.
//   If failure at STEP 6: Vault has data AND jar has cookie.
//     This is DEGRADED but not catastrophic. Report warning.
//
// ═══════════════════════════════════════════════════════════════

async function pipelineLock(password) {
  // ── STEP 1: VALIDATE ─────────────────────────────────────────
  if (!password || password.length === 0) {
    return { ok: false, error: 'Password cannot be empty.' };
  }

  const currentState = await resolveState();

  if (currentState === STATE.LOCKED) {
    return { ok: false, error: 'Vault is already locked. Unlock first, or wipe to start fresh.' };
  }

  // If currently unlocked, tear down the ghost session first
  if (currentState === STATE.UNLOCKED) {
    await GhostProtocol.deactivate();
    await Vault.setGhostActive(false);
    try { await chrome.alarms.clear(ALARM_AUTO_RELOCK); } catch (_) {}
  }

  // ── STEP 2: SNATCH ───────────────────────────────────────────
  const snatched = await GhostProtocol.snatch();
  if (!snatched) {
    return { ok: false, error: 'No active Roblox session found. Log into Roblox first, then lock.' };
  }

  let rawCookie = snatched.value;
  const cookieMeta = snatched.meta;
  // ► CHECKPOINT ALPHA: Raw cookie is in memory

  // ── STEP 3: ENCRYPT ──────────────────────────────────────────
  let encrypted;
  try {
    encrypted = XTCrypto.encrypt(rawCookie, password);
  } catch (e) {
    rawCookie = null;
    return { ok: false, error: 'Encryption failed: ' + e.message };
  }

  // ── STEP 4: VERIFY (Round-trip self-test) ────────────────────
  if (!XTCrypto.selfTest(rawCookie, password)) {
    rawCookie = null;
    encrypted = null;
    return { ok: false, error: 'Encryption self-test failed. The crypto engine may be corrupted. Aborting to protect your cookie.' };
  }
  // ► CHECKPOINT BRAVO: Encryption verified
  // Pre-nullify raw cookie — encrypt has consumed it
  rawCookie = null;

  // ── STEP 5: STORE ────────────────────────────────────────────
  const vaultData = {
    ciphertext: encrypted.ciphertext,
    salt: encrypted.salt,
    integrity: encrypted.integrity,
    lockedAt: Date.now(),
    cookieMeta: cookieMeta
  };
  encrypted = null; // Pre-nullify

  try {
    await Vault.write(vaultData);
  } catch (e) {
    return { ok: false, error: 'Failed to save to vault: ' + e.message };
  }
  // ► CHECKPOINT CHARLIE: Ciphertext persisted in vault

  // ── STEP 6: SCRUB ────────────────────────────────────────────
  const scrubResult = await GhostProtocol.scrubJar(3);
  // ► CHECKPOINT DELTA: Cookie jar is (hopefully) clean

  // ── STEP 7: CONFIRM ──────────────────────────────────────────
  await Vault.setState(STATE.LOCKED);
  await Vault.setGhostActive(false);

  return {
    ok: true,
    state: STATE.LOCKED,
    lockedAt: vaultData.lockedAt,
    scrubWarning: scrubResult.warning || null
  };
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 2: UNLOCK (GHOST SESSION ACTIVATION)
// ═══════════════════════════════════════════════════════════════
//
// This is where the Ghost Session Protocol ACTIVATES.
//
// TRADITIONAL UNLOCK would do:
//   Decrypt → Put cookie back in jar → Done
//   Problem: Cookie is re-exposed to all threats
//
// GHOST UNLOCK does:
//   Decrypt → Feed cookie to network-level injector → Done
//   Cookie NEVER enters the jar. It exists only in Chrome's
//   network rule engine, flowing into HTTP headers invisibly.
//
// The "mode" parameter allows fallback to traditional (direct)
// injection if Ghost Protocol cannot function.
//
// ═══════════════════════════════════════════════════════════════

async function pipelineUnlock(password, mode = 'ghost') {
  // ── STEP 1: VALIDATE ─────────────────────────────────────────
  if (!password || password.length === 0) {
    return { ok: false, error: 'Password cannot be empty.' };
  }

  const currentState = await resolveState();

  if (currentState === STATE.EMPTY) {
    return { ok: false, error: 'No vault data found. Lock a session first.' };
  }
  if (currentState === STATE.UNLOCKED) {
    return { ok: false, error: 'Session is already active.' };
  }

  // ── STEP 2: RETRIEVE ─────────────────────────────────────────
  const vaultData = await Vault.read();
  if (!vaultData || !vaultData.ciphertext || !vaultData.salt) {
    return { ok: false, error: 'Vault data is missing or corrupted.' };
  }

  // ── STEP 3: DECRYPT ──────────────────────────────────────────
  const result = XTCrypto.decrypt(
    vaultData.ciphertext,
    vaultData.salt,
    password,
    vaultData.integrity
  );

  if (!result.success) {
    return { ok: false, error: result.error };
  }

  let plaintext = result.plaintext;

  // Sanity check: cookie should be a non-trivial string
  if (!plaintext || plaintext.length < 20) {
    plaintext = null;
    return { ok: false, error: 'Decrypted data does not look like a valid session cookie.' };
  }

  // ── STEP 4: INJECT (Ghost or Direct) ─────────────────────────
  const useGhost = mode !== 'direct';

  try {
    if (useGhost) {
      // ┌──────────────────────────────────────────┐
      // │  GHOST SESSION PROTOCOL — ACTIVATION      │
      // │                                          │
      // │  The cookie enters Chrome's network rule  │
      // │  engine. It flows into HTTP headers.      │
      // │  It NEVER enters the cookie jar.          │
      // │  Other extensions see NOTHING.            │
      // │  The ghost is now whispering.             │
      // └──────────────────────────────────────────┘
      await GhostProtocol.activate(plaintext);
      await Vault.setGhostActive(true);
    } else {
      // ┌──────────────────────────────────────────┐
      // │  FALLBACK: DIRECT INJECTION               │
      // │                                          │
      // │  Cookie goes back into the jar.           │
      // │  This RE-EXPOSES it to all threats.       │
      // │  Use only if Ghost Protocol fails.        │
      // └──────────────────────────────────────────┘
      await GhostProtocol.directInject(plaintext, vaultData.cookieMeta);
    }
  } catch (e) {
    plaintext = null;
    return { ok: false, error: 'Injection failed: ' + e.message };
  }

  // ── STEP 5: CONFIRM ──────────────────────────────────────────
  plaintext = null; // CRITICAL: Null out immediately

  await Vault.setState(STATE.UNLOCKED);

  // Set auto-relock alarm
  await chrome.alarms.create(ALARM_AUTO_RELOCK, {
    delayInMinutes: DEFAULT_TIMEOUT_MINUTES
  });

  return {
    ok: true,
    state: STATE.UNLOCKED,
    mode: useGhost ? 'ghost' : 'direct',
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES
  };
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 3: RE-LOCK (from unlocked state)
// ═══════════════════════════════════════════════════════════════
//
// Tears down the ghost session. The cookie vanishes from
// the network layer. Master appears logged out.
// The vault remains sealed with the encrypted data.
//
// ═══════════════════════════════════════════════════════════════

async function pipelineRelock() {
  const currentState = await resolveState();
  if (currentState !== STATE.UNLOCKED) {
    return { ok: false, error: 'Not currently unlocked.' };
  }

  // Deactivate ghost session
  await GhostProtocol.deactivate();
  await Vault.setGhostActive(false);

  // Also scrub the jar in case Mode B (direct) was used
  await GhostProtocol.scrubJar(2);

  // Clear auto-relock alarm
  try { await chrome.alarms.clear(ALARM_AUTO_RELOCK); } catch (_) {}

  // Update state
  await Vault.setState(STATE.LOCKED);

  return { ok: true, state: STATE.LOCKED };
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 4: WIPE (permanent destruction)
// ═══════════════════════════════════════════════════════════════

async function pipelineWipe() {
  // Nuclear: destroy everything
  await GhostProtocol.deactivate();
  await GhostProtocol.scrubJar(2);
  await Vault.obliterate();
  try { await chrome.alarms.clear(ALARM_AUTO_RELOCK); } catch (_) {}
  await Vault.setState(STATE.EMPTY);

  return { ok: true, state: STATE.EMPTY };
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE 5: PEEK (verify without unlocking)
// ═══════════════════════════════════════════════════════════════

async function pipelinePeek(password) {
  if (!password || password.length === 0) {
    return { valid: false, error: 'Password cannot be empty.' };
  }

  const vaultData = await Vault.read();
  if (!vaultData || !vaultData.ciphertext) {
    return { valid: false, error: 'No vault data found.' };
  }

  const result = XTCrypto.decrypt(
    vaultData.ciphertext,
    vaultData.salt,
    password,
    vaultData.integrity
  );

  // DO NOT use the result. DO NOT store it. Just check validity.
  return { valid: result.success };
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE LISTENER — The Gate communicates with us here
// ═══════════════════════════════════════════════════════════════
//
// Every message from the Gate follows this schema:
//   { source: "GATE", action: "<ACTION>", payload: { ... } }
//
// Every response follows this schema:
//   { source: "GUARDIAN", action: "<RESPONSE>", payload: { ... } }
//
// The Gate is a REMOTE CONTROL. It sends button presses.
// We do the work and report back.
//
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== 'GATE') return false;

  const { action, payload = {} } = message;

  (async () => {
    let response;

    try {
      switch (action) {

        // ── STATUS REQUEST ───────────────────────
        case 'STATUS_REQUEST': {
          const state = await fastStateCheck();
          const vaultData = await Vault.read();

          let lockedAt = vaultData?.lockedAt || null;
          let timeoutMinutes = null;
          let ghostActive = false;

          if (state === STATE.UNLOCKED) {
            ghostActive = await Vault.isGhostActive();
            try {
              const alarm = await chrome.alarms.get(ALARM_AUTO_RELOCK);
              if (alarm) {
                const remaining = Math.max(0, alarm.scheduledTime - Date.now());
                timeoutMinutes = remaining / 60000; // fractional minutes
              }
            } catch (_) {}
          }

          response = {
            source: 'GUARDIAN',
            action: 'STATE_UPDATE',
            payload: {
              state,
              lockedAt,
              timeoutMinutes,
              ghostActive,
              timestamp: Date.now()
            }
          };
          break;
        }

        // ── LOCK REQUEST ─────────────────────────
        case 'LOCK_REQUEST': {
          const result = await pipelineLock(payload.password);
          response = {
            source: 'GUARDIAN',
            action: result.ok ? 'LOCK_SUCCESS' : 'LOCK_FAILURE',
            payload: result.ok
              ? { state: STATE.LOCKED, lockedAt: result.lockedAt, scrubWarning: result.scrubWarning }
              : { error: result.error }
          };
          break;
        }

        // ── UNLOCK REQUEST ───────────────────────
        case 'UNLOCK_REQUEST': {
          const result = await pipelineUnlock(payload.password, payload.mode);
          response = {
            source: 'GUARDIAN',
            action: result.ok ? 'UNLOCK_SUCCESS' : 'UNLOCK_FAILURE',
            payload: result.ok
              ? { state: STATE.UNLOCKED, mode: result.mode, timeoutMinutes: result.timeoutMinutes }
              : { error: result.error }
          };
          break;
        }

        // ── RELOCK REQUEST ───────────────────────
        case 'RELOCK_REQUEST': {
          const result = await pipelineRelock();
          response = {
            source: 'GUARDIAN',
            action: result.ok ? 'STATE_UPDATE' : 'LOCK_FAILURE',
            payload: result.ok
              ? { state: STATE.LOCKED, timestamp: Date.now() }
              : { error: result.error }
          };
          break;
        }

        // ── WIPE REQUEST ─────────────────────────
        case 'WIPE_REQUEST': {
          const result = await pipelineWipe();
          response = {
            source: 'GUARDIAN',
            action: 'WIPE_SUCCESS',
            payload: { state: STATE.EMPTY, timestamp: Date.now() }
          };
          break;
        }

        // ── PEEK REQUEST ─────────────────────────
        case 'PEEK_REQUEST': {
          const result = await pipelinePeek(payload.password);
          response = {
            source: 'GUARDIAN',
            action: 'PEEK_RESULT',
            payload: { valid: result.valid, error: result.error || null }
          };
          break;
        }

        // ── UNKNOWN ACTION ───────────────────────
        default:
          response = {
            source: 'GUARDIAN',
            action: 'ERROR',
            payload: { error: 'Unknown action: ' + action }
          };
      }
    } catch (e) {
      response = {
        source: 'GUARDIAN',
        action: 'ERROR',
        payload: { error: 'Guardian internal error: ' + e.message }
      };
    }

    sendResponse(response);
  })();

  return true; // Will respond asynchronously
});

// ═══════════════════════════════════════════════════════════════
// ALARM LISTENER — Auto-relock timeout
// ═══════════════════════════════════════════════════════════════
//
// When the auto-relock alarm fires:
//   1. Ghost session is deactivated (rules removed)
//   2. Cookie jar is scrubbed (in case Mode B was used)
//   3. State transitions to LOCKED
//
// The vault data remains encrypted and intact.
// Master can re-unlock at any time with the password.
//
// ═══════════════════════════════════════════════════════════════

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_AUTO_RELOCK) return;

  const currentState = await resolveState();
  if (currentState === STATE.UNLOCKED) {
    await GhostProtocol.deactivate();
    await Vault.setGhostActive(false);
    await GhostProtocol.scrubJar(2);
    await Vault.setState(STATE.LOCKED);
  }
});

// ═══════════════════════════════════════════════════════════════
// STARTUP — State resolution on install, update, and wake
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  await resolveState();
});

// Resolve state every time the Service Worker starts
(async () => {
  await resolveState();
})();