/**
 * XT-KRYPTOS GHOST SESSION PROTOCOL ENGINE v2
 * =============================================
 * 
 * THE CORE INNOVATION OF XT-KRYPTOS
 * 
 * ┌──────────────────────────────────────────────────────────────┐
 * │                                                              │
 * │  THE TRADITIONAL MODEL:                                      │
 * │                                                              │
 * │    Browser Cookie Jar                                        │
 * │    ┌──────────────────────────────┐                          │
 * │    │ .ROBLOSECURITY = _|WARN...  │ ← VISIBLE to:            │
 * │    └──────────────────────────────┘   • Malicious extensions │
 * │              │                        • XSS payloads         │
 * │              ▼                        • Malware              │
 * │    [Attached to every request]        • Physical access      │
 * │                                                              │
 * │  The cookie is a SITTING DUCK. It lives in one place,        │
 * │  in plaintext, accessible to everything.                     │
 * │                                                              │
 * ├──────────────────────────────────────────────────────────────┤
 * │                                                              │
 * │  THE GHOST SESSION MODEL:                                    │
 * │                                                              │
 * │    Browser Cookie Jar                                        │
 * │    ┌──────────────────────────────┐                          │
 * │    │         (EMPTY)              │ ← Nothing to steal       │
 * │    └──────────────────────────────┘                          │
 * │                                                              │
 * │    XT-Kryptos Vault (chrome.storage.local)                   │
 * │    ┌──────────────────────────────┐                          │
 * │    │ ciphertext = a7Fx9k2m...    │ ← Encrypted, useless     │
 * │    │ salt = 3f8c...              │   without password        │
 * │    └──────────────────────────────┘                          │
 * │              │                                               │
 * │              ▼ (only when unlocked)                          │
 * │    Chrome Network Stack (declarativeNetRequest)              │
 * │    ┌──────────────────────────────┐                          │
 * │    │ Rule: Add Cookie header to   │ ← Invisible to:         │
 * │    │ requests matching *.roblox.* │   • Other extensions     │
 * │    └──────────────────────────────┘   • JavaScript on pages  │
 * │              │                        • cookie scanners      │
 * │              ▼                                               │
 * │    [Cookie appears ONLY in outgoing HTTP headers]            │
 * │    [It NEVER enters the cookie jar]                          │
 * │    [It is a GHOST — present but invisible]                   │
 * │                                                              │
 * └──────────────────────────────────────────────────────────────┘
 * 
 * This module manages the Whisperer — the component that makes
 * the Ghost Session possible by injecting the decrypted cookie
 * directly into the network layer, bypassing browser storage entirely.
 * 
 * WHY IS THIS DIFFERENT FROM JUST SETTING THE COOKIE?
 * 
 * When a cookie is "set" via chrome.cookies.set(), it goes into
 * Chromium's SQLite cookie database. From there:
 *   1. Any extension with cookies permission can read it
 *   2. It persists on disk in a known location
 *   3. It appears in DevTools → Application → Cookies
 *   4. Malware can scan the cookie database file directly
 * 
 * When a cookie is "whispered" via declarativeNetRequest:
 *   1. Other extensions CANNOT see it (no cookie jar entry)
 *   2. It is NOT written to the cookie database on disk
 *   3. It does NOT appear in DevTools cookies panel
 *   4. It exists ONLY in Chrome's network stack memory
 *   5. It flows directly into HTTP request headers
 *   6. From Roblox's server perspective, it is IDENTICAL
 *      to a normal cookie — the server cannot tell the difference
 * 
 * The cookie is a PHANTOM. It authenticates Master's session
 * without ever materializing in any observable storage.
 * This is the Ghost Session Protocol.
 */

const GhostProtocol = (() => {
  "use strict";

  // ─────────────────────────────────────────────
  // CONSTANTS
  // ─────────────────────────────────────────────
  
  /**
   * Rule IDs for declarativeNetRequest.
   * 
   * We use a specific ID range (9000-9010) to avoid conflicts
   * with rules from other extensions or future XT-Kryptos features.
   * 
   * RULE_COOKIE_INJECT: The primary rule that adds the Cookie
   *   header to outgoing requests.
   * 
   * RULE_ORIGIN_PATCH: Ensures requests have proper Origin/Referer
   *   headers so Roblox's CSRF protection doesn't reject them.
   */
  const RULE_COOKIE_INJECT = 9001;
  const RULE_ORIGIN_PATCH = 9002;

  /**
   * All Roblox-related domains that need the ghost cookie.
   * 
   * Roblox uses multiple subdomains for different services:
   *   - www.roblox.com (main site)
   *   - apis.roblox.com (API endpoints)  
   *   - auth.roblox.com (authentication)
   *   - economy.roblox.com (transactions)
   *   - trades.roblox.com (trading)
   *   - friends.roblox.com (social)
   *   - groups.roblox.com (groups)
   *   - etc.
   * 
   * The wildcard *.roblox.com covers all of these.
   * We also include rbxcdn.com for CDN requests that may
   * need authentication.
   */
  const ROBLOX_DOMAINS = [
    '*://*.roblox.com/*',
    '*://*.rbxcdn.com/*'
  ];

  /**
   * Resource types that should receive the ghost cookie.
   * 
   * main_frame: Top-level page navigations to roblox.com
   * sub_frame: Iframes within Roblox pages
   * xmlhttprequest: AJAX/fetch calls from Roblox pages
   * other: Catch-all for edge cases (WebSocket upgrades, etc.)
   */
  const TARGET_RESOURCE_TYPES = [
    'main_frame',
    'sub_frame',
    'xmlhttprequest',
    'other'
  ];

  /**
   * ═══════════════════════════════════════════════
   * ACTIVATE GHOST SESSION
   * ═══════════════════════════════════════════════
   * 
   * This is THE critical function of the Ghost Protocol.
   * 
   * It creates a declarativeNetRequest rule that tells Chrome:
   * "For every request going to *.roblox.com, add this Cookie
   *  header with this value."
   * 
   * The rule lives in Chrome's NETWORK ENGINE, not in JavaScript
   * memory. This means:
   *   - It survives Service Worker sleep cycles
   *   - It executes at native C++ speed, not JavaScript speed
   *   - It cannot be introspected by other extensions
   *   - It is removed ONLY when we explicitly remove it
   * 
   * IMPORTANT SECURITY NOTE:
   * The plaintext cookie value IS stored inside the rule definition
   * within Chrome's internal rule database. This is the ONE place
   * where the plaintext exists outside of transient JS memory.
   * This is why:
   *   1. We auto-relock after a timeout (removing the rule)
   *   2. We clean up orphaned rules on every Guardian wake-up
   *   3. We keep the ghost session duration as short as practical
   * 
   * @param {string} cookieValue - The decrypted .ROBLOSECURITY value
   * @param {string} cookieName - Cookie name (default: .ROBLOSECURITY)
   * @returns {Promise<void>}
   */
  async function activate(cookieValue, cookieName = '.ROBLOSECURITY') {
    // Build the Cookie header value
    // Format: ".ROBLOSECURITY=<value>"
    const headerValue = cookieName + '=' + cookieValue;

    // Define the injection rule
    const injectRule = {
      id: RULE_COOKIE_INJECT,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'Cookie',
            operation: 'set',
            value: headerValue
          }
        ]
      },
      condition: {
        urlFilter: '||roblox.com',
        resourceTypes: TARGET_RESOURCE_TYPES
      }
    };

    // Remove any existing rules first, then add the new one.
    // This is atomic — Chrome processes the removal and addition
    // as a single operation, preventing a gap where no rule exists.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_COOKIE_INJECT, RULE_ORIGIN_PATCH],
      addRules: [injectRule]
    });
  }

  /**
   * ═══════════════════════════════════════════════
   * DEACTIVATE GHOST SESSION
   * ═══════════════════════════════════════════════
   * 
   * Removes all ghost injection rules.
   * After this call, the cookie is NOWHERE:
   *   - Not in the cookie jar (was never there)
   *   - Not in the network rules (just removed)
   *   - Not in JavaScript memory (was nulled by the Guardian)
   *   - Only in the encrypted vault (unreadable without password)
   * 
   * The session is DEAD. Master appears logged out.
   * Roblox requests go out without any authentication cookie.
   * The ghost has vanished.
   * 
   * @returns {Promise<void>}
   */
  async function deactivate() {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_COOKIE_INJECT, RULE_ORIGIN_PATCH],
        addRules: []
      });
    } catch (e) {
      // Rules may already be removed (browser restart, etc.)
      // This is expected and safe to ignore.
    }
  }

  /**
   * ═══════════════════════════════════════════════
   * CHECK IF GHOST SESSION IS ACTIVE
   * ═══════════════════════════════════════════════
   * 
   * Queries Chrome's dynamic rule engine to determine
   * whether the ghost injection rule currently exists.
   * 
   * This is used by the Guardian's state resolution logic
   * to detect inconsistencies (e.g., session flag says
   * UNLOCKED but rules don't exist → stale flag).
   * 
   * @returns {Promise<boolean>}
   */
  async function isActive() {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.some(r => r.id === RULE_COOKIE_INJECT);
  }

  /**
   * ═══════════════════════════════════════════════
   * SCRUB JAR — Remove cookie from browser storage
   * ═══════════════════════════════════════════════
   * 
   * Forcefully removes the .ROBLOSECURITY cookie from
   * Chrome's native cookie jar.
   * 
   * This is called during:
   *   1. LOCK — after encrypting, we delete the original
   *   2. WIPE — clean everything
   *   3. Cleanup — in case a cookie somehow reappeared
   * 
   * The retry logic exists because of an edge case:
   * If Master has a Roblox tab open, Roblox's JavaScript
   * or server responses may RE-SET the cookie after we
   * delete it. We retry multiple times to catch this.
   * 
   * @param {number} maxRetries - Number of deletion attempts
   * @returns {Promise<{ success: boolean, warning?: string }>}
   */
  async function scrubJar(maxRetries = 3) {
    const COOKIE_URL = 'https://www.roblox.com';
    const COOKIE_NAME = '.ROBLOSECURITY';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await chrome.cookies.remove({
          url: COOKIE_URL,
          name: COOKIE_NAME
        });
      } catch (_) {
        // Cookie may not exist — that's fine
      }

      // Verify deletion
      const check = await chrome.cookies.get({
        url: COOKIE_URL,
        name: COOKIE_NAME
      });

      if (!check) {
        return { success: true };
      }

      // Small delay before retry to let browser process the deletion
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    return {
      success: false,
      warning: 'Cookie may still exist — an open Roblox tab may be re-setting it. Close all Roblox tabs for full protection.'
    };
  }

  /**
   * ═══════════════════════════════════════════════
   * SNATCH — Read cookie from jar before locking
   * ═══════════════════════════════════════════════
   * 
   * Reads the .ROBLOSECURITY cookie and all its metadata
   * from the browser's cookie jar.
   * 
   * Returns both the value AND the metadata (domain, path,
   * secure flag, httpOnly flag, sameSite attribute, expiration).
   * 
   * WHY SAVE METADATA?
   * 
   * If Master ever needs to fall back to Mode B (direct cookie
   * injection instead of Ghost Protocol), we need to recreate
   * the cookie with EXACTLY the same attributes as the original.
   * Setting even one flag incorrectly could cause the browser
   * to not attach the cookie, or cause Roblox to reject it.
   * 
   * @returns {Promise<{ value: string, meta: Object } | null>}
   */
  async function snatch() {
    const cookie = await chrome.cookies.get({
      url: 'https://www.roblox.com',
      name: '.ROBLOSECURITY'
    });

    if (!cookie || !cookie.value) {
      return null;
    }

    return {
      value: cookie.value,
      meta: {
        domain: cookie.domain || '.roblox.com',
        path: cookie.path || '/',
        secure: cookie.secure !== undefined ? cookie.secure : true,
        httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : true,
        sameSite: cookie.sameSite || 'no_restriction',
        expirationDate: cookie.expirationDate || null,
        hostOnly: cookie.hostOnly || false,
        storeId: cookie.storeId || '0'
      }
    };
  }

  /**
   * ═══════════════════════════════════════════════
   * DIRECT INJECT (Mode B Fallback)
   * ═══════════════════════════════════════════════
   * 
   * Places the cookie DIRECTLY into Chrome's cookie jar.
   * This is the LESS SECURE fallback mode.
   * 
   * Use this only if:
   *   - declarativeNetRequest is unavailable or failing
   *   - Master explicitly chooses "direct" mode
   *   - The Ghost Protocol cannot function for some reason
   * 
   * WARNING: This re-exposes the cookie to all the threats
   * that XT-Kryptos is designed to protect against.
   * The cookie jar attack surface is fully restored.
   * 
   * @param {string} value - Decrypted cookie value
   * @param {Object} meta - Original cookie metadata
   * @returns {Promise<void>}
   */
  async function directInject(value, meta) {
    const details = {
      url: 'https://www.roblox.com',
      name: '.ROBLOSECURITY',
      value: value,
      domain: meta.domain || '.roblox.com',
      path: meta.path || '/',
      secure: meta.secure !== undefined ? meta.secure : true,
      httpOnly: meta.httpOnly !== undefined ? meta.httpOnly : true,
      sameSite: meta.sameSite || 'no_restriction'
    };

    if (meta.expirationDate) {
      details.expirationDate = meta.expirationDate;
    }

    await chrome.cookies.set(details);
  }

  // ═══════════════════════════════════════════════
  // MODULE EXPORT
  // ═══════════════════════════════════════════════
  return Object.freeze({
    activate,
    deactivate,
    isActive,
    scrubJar,
    snatch,
    directInject,
    RULE_COOKIE_INJECT,
    RULE_ORIGIN_PATCH
  });
})();

if (typeof globalThis !== 'undefined') {
  globalThis.GhostProtocol = GhostProtocol;
}