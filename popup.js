/**
 * XT-KRYPTOS v2 — THE GATE
 * ==========================
 * 
 * PURE PRESENTATION AND INPUT LAYER
 * 
 * ┌────────────────────────────────────────────────────┐
 * │  THIS FILE HAS:                                    │
 * │    ✓ Zero business logic                           │
 * │    ✓ Zero cryptographic capability                 │
 * │    ✓ Zero cookie access                            │
 * │    ✓ Zero storage access                           │
 * │    ✓ Zero network interaction                      │
 * │                                                    │
 * │  THIS FILE IS:                                     │
 * │    A remote control. Nothing more, nothing less.   │
 * │    Every button press → message to Guardian.       │
 * │    Every state change → response from Guardian.    │
 * │                                                    │
 * │  SECURITY RATIONALE:                               │
 * │    The popup is the most "exposed" surface of the  │
 * │    extension. By ensuring it holds zero secrets     │
 * │    and performs zero sensitive operations, we       │
 * │    guarantee that even total popup compromise      │
 * │    yields the attacker nothing. They get a remote  │
 * │    control with no batteries.                      │
 * └────────────────────────────────────────────────────┘
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════
  // DOM CACHE
  // ═══════════════════════════════════════════════
  const $ = (s) => document.querySelector(s);

  const el = {
    // views
    viewLoading  : $('#viewLoading'),
    viewEmpty    : $('#viewEmpty'),
    viewLocked   : $('#viewLocked'),
    viewUnlocked : $('#viewUnlocked'),

    // status
    statusDot    : $('#statusDot'),
    statusLabel  : $('#statusLabel'),

    // empty face
    pwLock       : $('#pwLock'),
    btnLock      : $('#btnLock'),
    strengthFill : $('#strengthFill'),
    strengthText : $('#strengthText'),

    // locked face
    pwUnlock     : $('#pwUnlock'),
    btnUnlock    : $('#btnUnlock'),
    btnPeek      : $('#btnPeek'),
    btnWipe      : $('#btnWipe'),
    dispLockedAt : $('#dispLockedAt'),

    // unlocked face
    btnRelock    : $('#btnRelock'),
    dispMode     : $('#dispMode'),
    dispTimer    : $('#dispTimer'),

    // toast
    toast        : $('#toast'),
    toastText    : $('#toastText'),
    toastClose   : $('#toastClose'),

    // wipe modal
    wipeOverlay  : $('#wipeOverlay'),
    wipeInput    : $('#wipeInput'),
    wipeCancel   : $('#wipeCancel'),
    wipeConfirm  : $('#wipeConfirm'),
  };

  // ═══════════════════════════════════════════════
  // LOCAL STATE (display mirror — never source of truth)
  // ═══════════════════════════════════════════════
  let currentState = null;
  let timerInterval = null;
  let timerTarget = null;

  // ═══════════════════════════════════════════════
  // GUARDIAN COMMUNICATION
  // ═══════════════════════════════════════════════

  function sendToGuardian(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { source: 'GATE', action, payload },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        }
      );
    });
  }

  // ═══════════════════════════════════════════════
  // VIEW MANAGEMENT
  // ═══════════════════════════════════════════════

  function showView(id) {
    ['viewLoading', 'viewEmpty', 'viewLocked', 'viewUnlocked'].forEach(v => {
      el[v].classList.remove('active');
    });
    el[id]?.classList.add('active');
  }

  function updateBadge(state) {
    el.statusDot.className = 'status-dot';
    switch (state) {
      case 'EMPTY':
        el.statusDot.classList.add('s-empty');
        el.statusLabel.textContent = 'NO VAULT';
        break;
      case 'LOCKED':
        el.statusDot.classList.add('s-locked');
        el.statusLabel.textContent = 'SEALED';
        break;
      case 'UNLOCKED':
        el.statusDot.classList.add('s-unlocked');
        el.statusLabel.textContent = 'GHOST ACTIVE';
        break;
      default:
        el.statusLabel.textContent = '—';
    }
  }

  // ═══════════════════════════════════════════════
  // STATE TRANSITIONS
  // ═══════════════════════════════════════════════

  function transitionTo(state, data = {}) {
    currentState = state;
    updateBadge(state);
    hideToast();
    stopTimer();

    switch (state) {
      case 'EMPTY':
        showView('viewEmpty');
        el.pwLock.value = '';
        updateStrength('');
        break;

      case 'LOCKED':
        showView('viewLocked');
        el.pwUnlock.value = '';
        el.dispLockedAt.textContent = fmtTime(data.lockedAt);
        break;

      case 'UNLOCKED':
        showView('viewUnlocked');
        el.dispMode.textContent = data.ghostActive !== false ? 'Ghost' : 'Direct';
        if (data.timeoutMinutes != null && data.timeoutMinutes > 0) {
          startTimer(data.timeoutMinutes);
        } else {
          el.dispTimer.textContent = '--:--';
        }
        break;

      default:
        showView('viewEmpty');
    }
  }

  // ═══════════════════════════════════════════════
  // TIMESTAMP FORMATTING
  // ═══════════════════════════════════════════════

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ═══════════════════════════════════════════════
  // COUNTDOWN TIMER
  // ═══════════════════════════════════════════════

  function startTimer(minutes) {
    stopTimer();
    timerTarget = Date.now() + minutes * 60000;
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function tick() {
    const rem = Math.max(0, timerTarget - Date.now());
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.dispTimer.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    if (rem <= 0) {
      stopTimer();
      refreshStatus();
    }
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    timerTarget = null;
  }

  // ═══════════════════════════════════════════════
  // PASSWORD STRENGTH (local computation only)
  // Replicated locally to avoid round-trips per keystroke.
  // ═══════════════════════════════════════════════

  function updateStrength(pw) {
    if (!pw || pw.length === 0) {
      el.strengthFill.style.width = '0%';
      el.strengthText.textContent = '';
      return;
    }
    let s = 0;
    s += Math.min(pw.length * 3.5, 35);
    if (/[a-z]/.test(pw)) s += 10;
    if (/[A-Z]/.test(pw)) s += 12;
    if (/[0-9]/.test(pw)) s += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) s += 18;
    s += Math.min(new Set(pw).size * 1.5, 15);
    const pct = Math.min(s, 100);
    el.strengthFill.style.width = pct + '%';

    if (pct < 33) {
      el.strengthFill.style.background = '#ef4444';
      el.strengthText.textContent = 'Weak';
    } else if (pct < 66) {
      el.strengthFill.style.background = '#f59e0b';
      el.strengthText.textContent = 'Moderate';
    } else {
      el.strengthFill.style.background = '#22c55e';
      el.strengthText.textContent = 'Strong';
    }
  }

  // ═══════════════════════════════════════════════
  // TOAST (feedback banner)
  // ═══════════════════════════════════════════════

  function showToast(msg, type = 'err') {
    el.toastText.textContent = msg;
    el.toast.className = 'toast t-' + type;
    if (type === 'ok') setTimeout(hideToast, 4500);
  }

  function hideToast() {
    el.toast.className = 'toast hidden';
  }

  // ═══════════════════════════════════════════════
  // BUTTON LOADING
  // ═══════════════════════════════════════════════

  function setLoading(btn, on) {
    btn.classList.toggle('is-loading', on);
    btn.disabled = on;
  }

  // ═══════════════════════════════════════════════
  // SHAKE (wrong password feedback)
  // ═══════════════════════════════════════════════

  function shakeField(input) {
    input.classList.add('is-shake');
    setTimeout(() => input.classList.remove('is-shake'), 450);
    input.value = '';
    input.focus();
  }

  // ═══════════════════════════════════════════════
  // ACTION HANDLERS
  // ═══════════════════════════════════════════════

  async function refreshStatus() {
    try {
      const r = await sendToGuardian('STATUS_REQUEST');
      if (r?.payload) {
        transitionTo(r.payload.state, {
          lockedAt: r.payload.lockedAt,
          timeoutMinutes: r.payload.timeoutMinutes,
          ghostActive: r.payload.ghostActive
        });
      }
    } catch (e) {
      showToast('Cannot reach Guardian: ' + e.message, 'err');
      showView('viewEmpty');
    }
  }

  async function doLock() {
    const pw = el.pwLock.value;
    if (!pw) { showToast('Enter a password first.', 'err'); el.pwLock.focus(); return; }

    setLoading(el.btnLock, true);
    hideToast();

    try {
      const r = await sendToGuardian('LOCK_REQUEST', { password: pw });
      if (r.action === 'LOCK_SUCCESS') {
        transitionTo('LOCKED', { lockedAt: r.payload.lockedAt });
        showToast('Session locked — cookie encrypted and removed from browser.', 'ok');
        if (r.payload.scrubWarning) {
          setTimeout(() => showToast(r.payload.scrubWarning, 'warn'), 2200);
        }
      } else {
        showToast(r.payload?.error || 'Lock failed.', 'err');
      }
    } catch (e) {
      showToast('Lock error: ' + e.message, 'err');
    } finally {
      setLoading(el.btnLock, false);
    }
  }

  async function doUnlock() {
    const pw = el.pwUnlock.value;
    if (!pw) { showToast('Enter your password.', 'err'); el.pwUnlock.focus(); return; }

    setLoading(el.btnUnlock, true);
    hideToast();

    try {
      const r = await sendToGuardian('UNLOCK_REQUEST', { password: pw, mode: 'ghost' });
      if (r.action === 'UNLOCK_SUCCESS') {
        transitionTo('UNLOCKED', {
          ghostActive: r.payload.mode === 'ghost',
          timeoutMinutes: r.payload.timeoutMinutes
        });
        showToast('Ghost session activated — cookie is invisible but functional.', 'ok');
      } else {
        showToast(r.payload?.error || 'Unlock failed.', 'err');
        shakeField(el.pwUnlock);
      }
    } catch (e) {
      showToast('Unlock error: ' + e.message, 'err');
    } finally {
      setLoading(el.btnUnlock, false);
    }
  }

  async function doRelock() {
    setLoading(el.btnRelock, true);
    hideToast();

    try {
      const r = await sendToGuardian('RELOCK_REQUEST');
      if (r.action === 'STATE_UPDATE' && r.payload?.state === 'LOCKED') {
        transitionTo('LOCKED', { lockedAt: r.payload.lockedAt });
        showToast('Ghost session terminated. Vault re-sealed.', 'ok');
      } else {
        showToast(r.payload?.error || 'Re-lock failed.', 'err');
      }
    } catch (e) {
      showToast('Re-lock error: ' + e.message, 'err');
    } finally {
      setLoading(el.btnRelock, false);
    }
  }

  async function doPeek() {
    const pw = el.pwUnlock.value;
    if (!pw) { showToast('Type your password, then click Peek.', 'err'); el.pwUnlock.focus(); return; }

    setLoading(el.btnPeek, true);
    hideToast();

    try {
      const r = await sendToGuardian('PEEK_REQUEST', { password: pw });
      if (r.action === 'PEEK_RESULT') {
        if (r.payload.valid) {
          showToast('✓ Password correct — vault data is intact.', 'ok');
        } else {
          showToast('✗ Wrong password or corrupted data.', 'err');
          shakeField(el.pwUnlock);
        }
      }
    } catch (e) {
      showToast('Peek error: ' + e.message, 'err');
    } finally {
      setLoading(el.btnPeek, false);
    }
  }

  function openWipeModal() {
    el.wipeOverlay.classList.remove('hidden');
    el.wipeInput.value = '';
    el.wipeConfirm.disabled = true;
    el.wipeInput.focus();
  }

  function closeWipeModal() {
    el.wipeOverlay.classList.add('hidden');
    el.wipeInput.value = '';
  }

  async function doWipe() {
    setLoading(el.wipeConfirm, true);
    hideToast();

    try {
      await sendToGuardian('WIPE_REQUEST');
      closeWipeModal();
      transitionTo('EMPTY');
      showToast('Vault destroyed permanently.', 'ok');
    } catch (e) {
      showToast('Wipe error: ' + e.message, 'err');
    } finally {
      setLoading(el.wipeConfirm, false);
    }
  }

  // ═══════════════════════════════════════════════
  // EVENT BINDING
  // ═══════════════════════════════════════════════

  // Buttons
  el.btnLock.addEventListener('click', doLock);
  el.btnUnlock.addEventListener('click', doUnlock);
  el.btnRelock.addEventListener('click', doRelock);
  el.btnPeek.addEventListener('click', doPeek);
  el.btnWipe.addEventListener('click', openWipeModal);

  // Toast
  el.toastClose.addEventListener('click', hideToast);

  // Wipe modal
  el.wipeCancel.addEventListener('click', closeWipeModal);
  el.wipeConfirm.addEventListener('click', doWipe);
  el.wipeInput.addEventListener('input', () => {
    el.wipeConfirm.disabled = el.wipeInput.value !== 'WIPE';
  });
  el.wipeOverlay.addEventListener('click', (e) => {
    if (e.target === el.wipeOverlay) closeWipeModal();
  });

  // Password strength
  el.pwLock.addEventListener('input', () => updateStrength(el.pwLock.value));

  // Enter key shortcuts
  el.pwLock.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLock(); });
  el.pwUnlock.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  el.wipeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.wipeConfirm.disabled) doWipe();
    if (e.key === 'Escape') closeWipeModal();
  });

  // Password visibility toggles
  document.querySelectorAll('.field-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) {
        const isPass = target.type === 'password';
        target.type = isPass ? 'text' : 'password';
        btn.setAttribute('aria-label', isPass ? 'Hide password' : 'Show password');
      }
    });
  });

  // ═══════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════
  refreshStatus();

})();