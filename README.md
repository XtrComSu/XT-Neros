# XT-Neros — Ghost Session Protocol: Roblox Cookie Security Chrome Extension

> **XT-Neros is a Manifest V3 Chrome extension for Roblox session cookie protection.** It removes the `.ROBLOSECURITY` cookie from the browser cookie jar and injects it at the network level — preventing malware, malicious extensions, and XSS payloads from stealing your Roblox authentication. Formerly XT-KRYPTOS v2. MIT licensed. Built for security-minded Roblox users who need session protection without sacrificing convenience.

The `.ROBLOSECURITY` cookie is the master key to a Roblox account. Anyone who possesses it can authenticate as that user. Traditional cookie managers store it in the cookie jar — the same place malware, malicious extensions, and XSS payloads know to look.

XT-Neros removes it from the jar entirely. The cookie lives encrypted in a vault. When needed, it is injected directly into HTTP headers at the network level — never touching the cookie jar, never visible to any browser API, present only in the packets leaving your machine.

---

## Architecture — The Trust Hierarchy

The system is designed with a **zero-trust, compartmentalised** architecture. No single component holds both the ciphertext and the means to decrypt it.

```
LEVEL 4  —  THE GUARDIAN   (background.js)
           Sees plaintext during operations. Has all Chrome API access.
           Makes all decisions. The ONLY component that touches secrets.

LEVEL 3  —  THE VAULT      (lib/vault.js)
           Holds encrypted data. Cannot decrypt on its own.
           Trusted with the lockbox but not the key.

LEVEL 2  —  THE WHISPERER  (lib/ghost.js — Ghost Protocol)
           Handles plaintext in transit (network headers).
           Cannot store, log, or redirect the data.
           A courier — carries the message, cannot exfiltrate.

LEVEL 1  —  THE GATE       (popup.js / popup.html)
           Sees the master password briefly (input field).
           Immediately sends it to the Guardian and forgets.
           Never sees the cookie. Never sees ciphertext.
           The receptionist — takes your name, does not know
           what is in the vault.
```

### How they interact

```
┌─────────────────────────────────────────────────────────────┐
│                      LOCK PIPELINE                           │
│                                                              │
│  Gate → sends password                                       │
│  Guardian → snatches cookie from jar                         │
│           → encrypts with password                           │
│           → stores ciphertext in Vault                       │
│           → deletes cookie from jar                          │
│           → returns success to Gate                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     UNLOCK PIPELINE                          │
│                                                              │
│  Gate → sends password                                       │
│  Guardian → reads ciphertext from Vault                      │
│           → decrypts with password                           │
│           → feeds cookie to Ghost Protocol                   │
│           → cookie enters network rule engine                │
│           → cookie NEVER re-enters jar                       │
│           → returns success to Gate                          │
└─────────────────────────────────────────────────────────────┘
```

---

## The Ghost Session Protocol — Core Innovation

### The Traditional Model

```
Browser Cookie Jar
┌──────────────────────────────┐
│ .ROBLOSECURITY = _|WARN...  │ ← VISIBLE to:
└──────────────────────────────┘   • Malicious extensions
          │                        • XSS payloads
          ▼                        • Malware
   [Attached to every request]     • Physical access
```

The cookie is a sitting duck. It lives in one place, in plaintext, accessible to everything.

### The Ghost Session Model

```
Browser Cookie Jar
┌──────────────────────────────┐
│         (EMPTY)              │ ← Nothing to steal
└──────────────────────────────┘

XT-Neros Vault (chrome.storage.local)
┌──────────────────────────────┐
│ ciphertext = a7Fx9k2m...    │ ← Encrypted, useless
│ salt = 3f8c...              │   without password
└──────────────────────────────┘
          │
          ▼ (only when unlocked)
Chrome Network Stack (declarativeNetRequest)
┌──────────────────────────────┐
│ Rule: Add Cookie header to   │ ← Invisible to:
│ requests matching *.roblox.* │   • Other extensions
└──────────────────────────────┘   • JavaScript on pages
          │                        • cookie scanners
          ▼
   [Cookie appears ONLY in outgoing HTTP headers]
   [It NEVER enters the cookie jar]
   [It is a GHOST — present but invisible]
```

### Why this matters

| Threat | Traditional | Ghost Protocol |
|--------|------------|----------------|
| Malicious extension with `cookies` permission | Can steal cookie from jar | **Cannot** — jar is empty |
| XSS on Roblox | Can read `document.cookie` | **Cannot** — cookie is not in document |
| Browser malware scanning cookie stores | Can find .ROBLOSECURITY | **Cannot** — not stored anywhere plain |
| Physical access to unlocked machine | Can open browser and copy cookie | **Cannot** — cookie is encrypted in vault |
| Another extension reading network requests | Can see cookie in headers | **Cannot** — network level is same, but cookie was never in jar for prior exfiltration |

---

## Installation

### From source

```
git clone git@github.com:XtrComSu/XT-Neros.git
cd XT-Neros
```

### Load into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `XT-Neros` directory

### Permissions requested

| Permission | Reason |
|-----------|--------|
| `cookies` | Snatch the .ROBLOSECURITY cookie for encryption |
| `storage` | Store the encrypted vault (local + session) |
| `declarativeNetRequest` | Ghost Protocol — inject cookie at network level |
| `declarativeNetRequestWithHostAccess` | Dynamic rule modifications |
| `alarms` | Auto-relock timer |
| `*.roblox.com/*` | Target domain for cookie operations |
| `*.rbxcdn.com/*` | Roblox CDN (may carry auth) |
| `*.roblox.qq.com/*` | Roblox China |

---

## Usage

### First run

1. Log into Roblox in any tab
2. Open the XT-Neros popup
3. Enter a **master password** — this will encrypt your cookie
4. Click **Lock**

The extension will:
- Snatch the `.ROBLOSECURITY` cookie from the jar
- Encrypt it with your password (salted XOR stream cipher, 1000 rounds)
- Store the ciphertext in the vault
- Delete the plaintext cookie from the jar
- Confirm the vault is sealed

### Subsequent sessions

1. Open the XT-Neros popup
2. Enter your master password
3. Click **Unlock**

The extension will:
- Read ciphertext from the vault
- Decrypt with your password
- Activate the Ghost Protocol — inject cookie via `declarativeNetRequest`
- Set a 30-minute auto-relock timer
- Confirm the session is active

Browse Roblox normally. The cookie flows into HTTP headers invisibly. Nothing sees it except the network packets.

### Auto-relock

After 30 minutes of inactivity in the unlocked state, the extension automatically tears down the ghost session. The cookie vanishes from the network layer. You appear logged out.

To change the timeout: edit `DEFAULT_TIMEOUT_MINUTES` in `background.js`.

### Manual relock

Open the popup and click **Relock**. The ghost session is deactivated immediately.

### Wipe

Destroys the vault entirely. The encrypted cookie is permanently lost. Use only if you want to start fresh.

---

## Technical Details

### Encryption algorithm

| Parameter | Value |
|-----------|-------|
| Algorithm | Salted multi-round XOR stream cipher |
| Key derivation | FNV-1a derivative, 1000 mixing rounds |
| Salt | 8 bytes, generated per encryption (`crypto.getRandomValues`) |
| Integrity | Truncated plaintext hash appended |
| Output encoding | Base64 |

**Why XOR, not AES?** This is a deliberate design decision. The threat model is cookie-stealing extensions and casual attackers, not nation-state cryptanalysis. XOR with a key stretched through 1000 rounds produces output computationally indistinguishable from random noise without the password. Synchronous execution means no Promise chains in the critical Lock pipeline — reducing the window where the Service Worker could be killed mid-operation. Simplicity is security: the entire algorithm can be verified by hand with no misconfigured IVs or key management footguns.

### State resolution engine

The Service Worker in Manifest V3 is **ephemeral**. Chrome may terminate it after ~30 seconds of inactivity. When an event arrives, Chrome re-instantiates it with no in-memory state.

The state resolution engine reconciles three independent sources of truth:

1. **Session flag** (chrome.storage.session) — what the system THINKS the state is
2. **Vault data** (chrome.storage.local) — whether encrypted data EXISTS
3. **Ghost rules** (declarativeNetRequest) — whether injection is ACTIVE

These can become inconsistent. The resolution engine handles: stale flags after Chrome restart, orphaned ghost rules after crashes, missing vault data after corruption — and resolves to the correct state every time.

### Pipeline safety — Checkpoint architecture

The Lock pipeline is the most dangerous operation — it involves **irreversible** cookie deletion. It uses a checkpoint-and-rollback architecture:

```
STEP 1  VALIDATE     → can abort cleanly
STEP 2  SNATCH       → cookie in memory | abort = nothing lost
        ▼ CHECKPOINT ALPHA
STEP 3  ENCRYPT      → ciphertext in memory | abort = nothing lost
STEP 4  VERIFY       → round-trip test | abort = nothing lost
        ▼ CHECKPOINT BRAVO
STEP 5  STORE        → ciphertext in vault | abort = cookie still in jar
        ▼ CHECKPOINT CHARLIE
STEP 6  SCRUB        → cookie deleted from jar
        ▼ CHECKPOINT DELTA
STEP 7  CONFIRM      → state updated, plaintext nulled
```

Failure before CHECKPOINT CHARLIE is always safe. Failure after means the vault has data AND the jar still has the cookie — degraded but not catastrophic.

---

## File structure

```
XT-Neros/
├── manifest.json          # Chrome Extension Manifest V3
├── background.js          # THE GUARDIAN — central nervous system
├── popup.html             # THE GATE — user interface
├── popup.js               # Gate controller logic
├── popup.css              # Gate styles
├── lib/
│   ├── crypto.js          # Encryption engine (XOR stream cipher)
│   ├── ghost.js           # Ghost Session Protocol — network injection
│   └── vault.js           # Storage abstraction (local + session)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Threat model

### In scope

- Malicious Chrome extensions with `cookies`, `storage`, or `webRequest` permissions
- XSS attacks on Roblox web pages
- Browser-based malware that scans cookie stores
- Physical access to an unlocked machine with the vault locked
- Other extensions reading network traffic (ghost makes no difference here — the cookie must leave the machine in HTTP headers)

### Out of scope

- Keyloggers capturing the master password at the moment of entry
- Compromise of the Chrome profile directory (vault data is encrypted, but an attacker with filesystem access could attempt offline bruteforce)
- Server-side attacks on Roblox infrastructure
- The user voluntarily sharing the decrypted cookie

---

## License

XT-Neros is part of the **XT-Series** — engineered on Arch Linux, built for the people, not for profit.
