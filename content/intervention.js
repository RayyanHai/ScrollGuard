// Intervention UI: full-page block overlay.
//
// This script runs in the IG page's isolated world. It receives BLOCK and
// UNBLOCK messages from the service worker (which decides when to send
// them based on the rules engine in service-worker.js). It does NOT decide
// itself — the SW is the single source of truth for "is this context
// blocked right now". The content script just renders.
//
// Why a full-page overlay rather than the spec's blur+nudge: you asked to
// feel the intervention, not be politely tapped on the shoulder. We can
// dial down to blur later in lib/config.js if it's too aggressive.

const SG_OVERLAY_ID = 'scrollguard-overlay-root';

// Track current state to avoid redundant DOM work and to avoid stomping
// when IG re-renders. The MutationObserver below is what defends against
// IG removing our node.
let currentMode = 'hidden'; // 'hidden' | 'blocked' | 'unlocked'
let countdownInterval = null;

// --- Video pausing while blocked -------------------------------------------
//
// IG keeps reel <video> elements playing when our overlay covers the page —
// you can hear audio through the overlay. We pause every video on block and
// add a capture-phase 'play' listener that re-pauses if IG/user tries to
// resume. The listener is removed on unlock/clear, so during the password
// grace period videos can play normally again.
//
// We don't auto-resume on unlock — letting IG manage its own play state
// avoids weird half-played frames or muted-audio glitches.

function pauseAllVideos() {
  document.querySelectorAll('video').forEach((v) => {
    try { v.pause(); } catch {}
  });
}

function blockPlayHandler(e) {
  if (e.target instanceof HTMLVideoElement) {
    try { e.target.pause(); } catch {}
  }
}

let videoBlockerInstalled = false;
function installVideoBlocker() {
  if (videoBlockerInstalled) return;
  // Capture phase = we hear the event before IG's own handlers, so our
  // pause() runs before whatever scheduling IG does in response.
  document.addEventListener('play', blockPlayHandler, true);
  videoBlockerInstalled = true;
}
function uninstallVideoBlocker() {
  if (!videoBlockerInstalled) return;
  document.removeEventListener('play', blockPlayHandler, true);
  videoBlockerInstalled = false;
}

function ensureOverlay() {
  let el = document.getElementById(SG_OVERLAY_ID);
  if (el) return el;

  el = document.createElement('div');
  el.id = SG_OVERLAY_ID;
  el.attachShadow({ mode: 'open' });
  // Shadow DOM isolates our styles from IG's CSS. Without it, IG's resets
  // would clobber our layout and our `position: fixed` could fight their
  // own stacking contexts. Shadow DOM is the cleanest defense.

  document.documentElement.appendChild(el);
  return el;
}

function renderBlocked({ group, blockedUntil, passwordSet }) {
  const el = ensureOverlay();
  const root = el.shadowRoot;
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(20, 8, 8, 0.97);
        color: #fef2f2;
        font: 16px/1.4 ui-sans-serif, system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
      }
      .card {
        max-width: 460px; width: 100%;
        text-align: center;
      }
      h1 { font-size: 28px; margin: 0 0 8px; font-weight: 600; }
      .sub { color: #fca5a5; margin: 0 0 24px; font-size: 14px; }
      .countdown {
        font: 600 48px/1 ui-monospace, monospace;
        margin: 16px 0 24px; color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .pwline { margin-top: 32px; }
      .pwlabel { font-size: 12px; color: #9ca3af; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
      input.pw {
        width: 100%; box-sizing: border-box;
        background: #1f1414; color: #fff; border: 1px solid #4c1d1d;
        border-radius: 6px; padding: 10px 12px; font: inherit;
        outline: none;
        /* Mask the characters as bullets without using type="password" —
           that way Chrome won't recognise it as a credential field and
           won't prompt to save/update the IG password after we submit. */
        -webkit-text-security: disc;
        text-security: disc;
        font-family: ui-monospace, monospace; /* keeps bullet width consistent */
      }
      input.pw:focus { border-color: #f87171; }
      .err { color: #fca5a5; font-size: 13px; margin-top: 8px; min-height: 18px; }
      .group-pill {
        display: inline-block; padding: 2px 10px; border-radius: 999px;
        background: #4c1d1d; color: #fecaca; font-size: 12px; letter-spacing: 0.04em;
        text-transform: uppercase; margin-bottom: 12px;
      }
      .setup-note {
        margin-top: 32px;
        padding: 14px 16px;
        background: #1a1010;
        border: 1px solid #4c1d1d;
        border-radius: 6px;
        color: #fecaca;
        font-size: 13px;
        line-height: 1.5;
      }
      .setup-note strong { color: #fff; }
    </style>
    <div class="wrap">
      <div class="card">
        <div class="group-pill">${group}</div>
        <h1>Blocked</h1>
        <p class="sub">You hit your ${group} limit.</p>
        <div class="countdown" id="cd">--:--</div>
        ${passwordSet ? `
        <div class="pwline">
          <div class="pwlabel">Type password to unlock briefly</div>
          <input id="pw" class="pw" type="text" name="sg-passphrase-${Math.random().toString(36).slice(2)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" />
          <div class="err" id="err"></div>
        </div>
        ` : `
        <div class="setup-note">
          <strong>No unlock password set.</strong><br>
          Open the ScrollGuard extension popup (toolbar icon) to set one. Until then, the block can only be waited out.
        </div>
        `}
      </div>
    </div>
  `;

  const cdEl = root.getElementById('cd');
  const pw = passwordSet ? root.getElementById('pw') : null;
  const err = passwordSet ? root.getElementById('err') : null;

  function tickCountdown() {
    const remaining = Math.max(0, blockedUntil - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    cdEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (remaining <= 0) {
      // Optimistic teardown: blockedUntil is the source of truth, so once
      // wall-clock passes it we know the block is done. We don't wait for
      // the SW's CLEAR message because in MV3 the SW may be asleep at the
      // exact moment the timer expires (setInterval doesn't keep SWs alive).
      // We still ping the SW for state to cover any edge case where the
      // block was extended; it'll re-render via BLOCK if so.
      clearInterval(countdownInterval);
      countdownInterval = null;
      hideOverlay();
      chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
    }
  }
  if (countdownInterval) clearInterval(countdownInterval);
  tickCountdown();
  countdownInterval = setInterval(tickCountdown, 1000);

  // Password input only exists when a password is configured. In setup mode
  // (first install) we skip all of this and the user gets the setup note instead.
  if (passwordSet && pw) {
    // Defeat Chrome's password autofill: it runs after the field is in the DOM,
    // so we wipe and refocus on a few delayed ticks. Two RAFs catches Chrome's
    // own autofill; the 100ms timeout catches slower password managers (LastPass, 1Password).
    pw.value = '';
    requestAnimationFrame(() => {
      pw.value = '';
      requestAnimationFrame(() => { pw.value = ''; pw.focus(); });
    });
    setTimeout(() => { pw.value = ''; pw.focus(); }, 100);

    pw.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const value = pw.value;
      pw.value = '';
      err.textContent = '';
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'TRY_UNLOCK', password: value });
        if (!resp?.ok) {
          err.textContent = 'Wrong password.';
          pw.focus();
        }
        // If ok, SW will send UNBLOCK and we'll tear down the overlay.
      } catch {
        err.textContent = 'SW unreachable. Reload tab.';
      }
    });
  }

  pauseAllVideos();
  installVideoBlocker();
  currentMode = 'blocked';
}

function renderUnlocked({ group, unlockUntil }) {
  uninstallVideoBlocker();
  // While unlocked, just remove the overlay. We could show a tiny banner
  // with the unlock countdown, but you said you wanted minimal — the SW
  // will re-block automatically when grace expires.
  const el = document.getElementById(SG_OVERLAY_ID);
  if (el) el.remove();
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  currentMode = 'unlocked';
}

function hideOverlay() {
  const el = document.getElementById(SG_OVERLAY_ID);
  if (el) el.remove();
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  uninstallVideoBlocker();
  currentMode = 'hidden';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'BLOCK') {
    renderBlocked(msg);
  } else if (msg?.type === 'UNLOCK') {
    renderUnlocked(msg);
  } else if (msg?.type === 'CLEAR') {
    hideOverlay();
  }
});

// Defend against IG re-rendering and removing our overlay node. When we're
// in `blocked` mode and the overlay disappears from the DOM, re-inject it.
// Cheap: only fires when childList of <html> changes, which IG does rarely.
const mo = new MutationObserver(() => {
  if (currentMode === 'blocked' && !document.getElementById(SG_OVERLAY_ID)) {
    // Ask SW to re-send the BLOCK message with current state. Simpler than
    // caching the args here, and the SW already has the source of truth.
    chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
  }
});
mo.observe(document.documentElement, { childList: true, subtree: false });

// On script load (i.e. fresh navigation or page reload), proactively ask the
// SW what state we should be in. This covers the race where the content
// script loads before the SW's onCommitted handler runs.
chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
