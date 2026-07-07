// Intervention UI: full-page challenge overlay.
//
// v3 (earn-to-scroll): the site is BLOCKED by default. The overlay is the gate —
// it renders on load and stays until the user passes a challenge that opens a
// scroll window. Two independent paths, both driven by the SW (single source of
// truth):
//   - Password  → TRY_UNLOCK
//   - Math set  → REQUEST_MATH_CHALLENGE → SUBMIT_MATH (SW generates + validates)
//
// The same script runs on every tracked platform; the SW tells us which one via
// the `platform`/`platformLabel` fields on BLOCK messages.

const SG_OVERLAY_ID = 'scrollguard-overlay-root';

// Track current state to avoid redundant DOM work and to avoid stomping when
// the site re-renders. The MutationObserver below defends against the site
// removing our node.
let currentMode = 'blocked'; // 'blocked' | 'unlocked'  (default blocked — see below)
let countdownInterval = null;

// Cache of the last BLOCK payload so we can re-render (e.g. after switching
// between the password and math views) without another SW round-trip.
let lastBlockMsg = null;

// --- Video pausing while blocked -------------------------------------------
//
// Sites keep reel <video> elements playing when our overlay covers the page —
// you can hear audio through the overlay. We pause every video on block and add
// a capture-phase 'play' listener that re-pauses if the site/user resumes. The
// listener is removed on unlock so during the scroll window videos play normally.

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
  // Shadow DOM isolates our styles from the site's CSS.
  document.documentElement.appendChild(el);
  return el;
}

// Shared stylesheet for the blocked overlay.
const OVERLAY_STYLES = `
  :host { all: initial; }
  .wrap {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(20, 8, 8, 0.98);
    color: #fef2f2;
    font: 16px/1.4 ui-sans-serif, system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; overflow: auto;
  }
  .card { max-width: 460px; width: 100%; text-align: center; }
  h1 { font-size: 28px; margin: 0 0 8px; font-weight: 600; }
  .sub { color: #fca5a5; margin: 0 0 24px; font-size: 14px; }
  .paths { display: flex; flex-direction: column; gap: 20px; margin-top: 8px; }
  .divider { display: flex; align-items: center; gap: 10px; color: #7f5555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #4c1d1d; }
  .pwlabel, .mathlabel { font-size: 12px; color: #9ca3af; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
  input.pw, input.ans {
    box-sizing: border-box;
    background: #1f1414; color: #fff; border: 1px solid #4c1d1d;
    border-radius: 6px; padding: 10px 12px; font: inherit;
    outline: none;
  }
  input.pw {
    width: 100%;
    /* Mask characters as bullets without type="password", so Chrome won't
       offer to save/update the site password after submit. */
    -webkit-text-security: disc; text-security: disc;
    font-family: ui-monospace, monospace;
  }
  input.pw:focus, input.ans:focus { border-color: #f87171; }
  .err { color: #fca5a5; font-size: 13px; margin-top: 8px; min-height: 18px; }
  button.sg-btn {
    width: 100%; box-sizing: border-box;
    background: #4c1d1d; color: #fff; border: 1px solid #7f1d1d;
    border-radius: 6px; padding: 11px 12px; font: inherit; font-weight: 600;
    cursor: pointer;
  }
  button.sg-btn:hover { background: #611f1f; }
  button.sg-btn.solid { background: #dc2626; border-color: #dc2626; }
  button.sg-btn.solid:hover { background: #ef4444; }
  .problems { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 14px; }
  .prob { display: flex; align-items: center; gap: 10px; justify-content: center; font-size: 20px; }
  .prob .q { font-variant-numeric: tabular-nums; min-width: 120px; text-align: right; }
  .prob input.ans { width: 90px; text-align: center; font-size: 18px; }
  .setup-note {
    margin-top: 8px; padding: 14px 16px; background: #1a1010;
    border: 1px solid #4c1d1d; border-radius: 6px; color: #fecaca;
    font-size: 13px; line-height: 1.5;
  }
  .setup-note strong { color: #fff; }
  .ceiling { font-size: 15px; color: #fca5a5; line-height: 1.6; }
`;

// ---------------------------------------------------------------------------
// Blocked overlay (the gate)
// ---------------------------------------------------------------------------

function renderBlocked(msg) {
  lastBlockMsg = msg;
  const {
    platformLabel, passwordEnabled, passwordSet,
    mathEnabled, ceilingReached,
  } = msg;
  const label = platformLabel || 'this site';

  const el = ensureOverlay();
  const root = el.shadowRoot;

  // Daily ceiling hit: no challenge available until tomorrow.
  if (ceilingReached) {
    root.innerHTML = `
      <style>${OVERLAY_STYLES}</style>
      <div class="wrap"><div class="card">
        <h1>Daily limit reached</h1>
        <p class="sub">You've used all your ${label} time for today.</p>
        <div class="ceiling">Come back tomorrow — the counter resets at midnight.</div>
      </div></div>`;
    finishBlockedRender(root, msg);
    return;
  }

  const showPw = passwordEnabled && passwordSet;
  const showMath = mathEnabled;

  const pwSection = showPw ? `
    <div class="pwline">
      <div class="pwlabel">Type password to unlock</div>
      <input id="pw" class="pw" type="text" name="sg-passphrase-${Math.random().toString(36).slice(2)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" />
      <div class="err" id="pwErr"></div>
    </div>` : '';

  const mathSection = showMath ? `
    <div class="mathline">
      <div class="mathlabel">Or solve math to unlock</div>
      <button id="startMath" class="sg-btn">Solve math problems</button>
      <div id="mathHost"></div>
    </div>` : '';

  const divider = (showPw && showMath) ? `<div class="divider">or</div>` : '';

  // On the very first placeholder paint (before the SW's authoritative BLOCK
  // arrives) we don't yet know the real config — show nothing rather than
  // flash the "no method" note.
  const noPathNote = (!showPw && !showMath && !msg._initial) ? `
    <div class="setup-note">
      <strong>No unlock method enabled.</strong><br>
      Open the ScrollGuard popup (toolbar icon) to set a password or enable math challenges.
    </div>` : '';

  root.innerHTML = `
    <style>${OVERLAY_STYLES}</style>
    <div class="wrap"><div class="card">
      <h1>Blocked</h1>
      <p class="sub">${label} is locked. Earn a scroll window to get in.</p>
      <div class="paths">
        ${pwSection}
        ${divider}
        ${mathSection}
        ${noPathNote}
      </div>
    </div></div>`;

  wirePasswordInput(root);
  wireMathButton(root, msg);
  finishBlockedRender(root, msg);
}

// Common teardown/setup shared by every blocked render (ceiling or challenge).
function finishBlockedRender(root, msg) {
  pauseAllVideos();
  installVideoBlocker();
  currentMode = 'blocked';
}

function wirePasswordInput(root) {
  const pw = root.getElementById('pw');
  const err = root.getElementById('pwErr');
  if (!pw) return;

  // Defeat Chrome's password autofill: wipe and refocus on a few delayed ticks.
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
      if (resp?.ceiling) {
        err.textContent = 'Daily limit reached — come back tomorrow.';
      } else if (!resp?.ok) {
        err.textContent = 'Wrong password.';
        pw.focus();
      }
      // On success the SW sends UNLOCK and we tear the overlay down.
    } catch {
      err.textContent = 'Extension unreachable. Reload tab.';
    }
  });
}

// ---------------------------------------------------------------------------
// Math challenge (rendered inline into #mathHost on demand)
// ---------------------------------------------------------------------------

function wireMathButton(root, msg) {
  const btn = root.getElementById('startMath');
  const host = root.getElementById('mathHost');
  if (!btn || !host) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'REQUEST_MATH_CHALLENGE' });
      if (resp?.ceiling) {
        host.innerHTML = `<div class="err">Daily limit reached — come back tomorrow.</div>`;
        return;
      }
      if (!resp?.ok || !Array.isArray(resp.problems)) {
        btn.disabled = false;
        btn.textContent = 'Solve math problems';
        host.innerHTML = `<div class="err">Couldn't load problems. Try again.</div>`;
        return;
      }
      btn.style.display = 'none';
      renderProblems(root, host, resp.problems);
    } catch {
      btn.disabled = false;
      btn.textContent = 'Solve math problems';
      host.innerHTML = `<div class="err">Extension unreachable. Reload tab.</div>`;
    }
  });
}

function opSymbol(op) {
  return op === '×' ? '×' : op; // already the display glyph from the SW
}

function renderProblems(root, host, problems, notice) {
  const rows = problems.map((p, i) => `
    <div class="prob">
      <span class="q">${p.a} ${opSymbol(p.op)} ${p.b} =</span>
      <input class="ans" data-i="${i}" type="number" inputmode="numeric" autocomplete="off" />
    </div>`).join('');

  host.innerHTML = `
    ${notice ? `<div class="err">${notice}</div>` : ''}
    <div class="problems">${rows}</div>
    <button id="submitMath" class="sg-btn solid">Unlock</button>
    <div class="err" id="mathErr"></div>`;

  const inputs = Array.from(host.querySelectorAll('input.ans'));
  const submit = host.querySelector('#submitMath');
  const err = host.querySelector('#mathErr');

  // Enter in any field moves to the next / submits on the last.
  inputs.forEach((inp, idx) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (idx < inputs.length - 1) inputs[idx + 1].focus();
      else submit.click();
    });
  });
  if (inputs[0]) setTimeout(() => inputs[0].focus(), 30);

  submit.addEventListener('click', async () => {
    const answers = inputs.map((inp) => inp.value.trim() === '' ? null : Number(inp.value));
    err.textContent = '';
    submit.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SUBMIT_MATH', answers });
      if (resp?.ok) return; // SW sends UNLOCK → overlay torn down
      if (resp?.ceiling) {
        host.innerHTML = `<div class="err">Daily limit reached — come back tomorrow.</div>`;
        return;
      }
      if (resp?.expired) {
        // Lost the challenge (SW slept). Re-request transparently.
        const fresh = await chrome.runtime.sendMessage({ type: 'REQUEST_MATH_CHALLENGE' });
        if (fresh?.ok && Array.isArray(fresh.problems)) {
          renderProblems(root, host, fresh.problems, 'Session refreshed — try this set.');
        } else {
          host.innerHTML = `<div class="err">Couldn't reload problems. Reload the tab.</div>`;
        }
        return;
      }
      // Wrong answers → SW handed back a fresh set.
      if (Array.isArray(resp?.problems)) {
        const n = resp.wrongCount ?? 0;
        renderProblems(root, host, resp.problems,
          `${n} wrong — here's a new set.`);
      } else {
        submit.disabled = false;
        err.textContent = 'Something went wrong. Try again.';
      }
    } catch {
      submit.disabled = false;
      err.textContent = 'Extension unreachable. Reload tab.';
    }
  });
}

// ---------------------------------------------------------------------------
// Unlocked / hidden
// ---------------------------------------------------------------------------

let windowExpiryTimer = null;

function renderUnlocked(msg) {
  uninstallVideoBlocker();
  const el = document.getElementById(SG_OVERLAY_ID);
  if (el) el.remove();
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  lastBlockMsg = null;
  currentMode = 'unlocked';

  // Re-lock promptly when the wall-clock window ends, rather than waiting for
  // the SW's next 30s tick. The SW's evaluateOverlay is by-wall-clock too, so
  // the REQUEST_BLOCK_STATE reply will correctly be BLOCK even pre-tick.
  if (windowExpiryTimer) { clearTimeout(windowExpiryTimer); windowExpiryTimer = null; }
  if (msg?.unlockUntil) {
    const ms = Math.max(0, msg.unlockUntil - Date.now());
    windowExpiryTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
    }, ms + 250);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'BLOCK') {
    renderBlocked(msg);
  } else if (msg?.type === 'UNLOCK') {
    renderUnlocked(msg);
  } else if (msg?.type === 'CLEAR') {
    // No longer used in the earn-to-scroll model, but tolerate it: treat as
    // "remove overlay" (equivalent to unlocked).
    renderUnlocked();
  }
});

// Defend against the site re-rendering and removing our overlay node while
// blocked. Re-render from the cached BLOCK payload (or ask the SW if we don't
// have one). Cheap: only fires when <html>'s childList changes.
const mo = new MutationObserver(() => {
  if (currentMode === 'blocked' && !document.getElementById(SG_OVERLAY_ID)) {
    if (lastBlockMsg) renderBlocked(lastBlockMsg);
    else chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
  }
});
mo.observe(document.documentElement, { childList: true, subtree: false });

// ---------------------------------------------------------------------------
// Initial render — default BLOCKED, no content flash.
// ---------------------------------------------------------------------------
//
// The inverted model means the site must be gated the instant the script runs.
// Runs at document_start, so the page's feed hasn't rendered yet.
//
// 1. SYNCHRONOUSLY paint a minimal block right now — this guarantees the feed
//    never shows on a blocked (default) load, even before any async work.
// 2. Then read blockState directly from chrome.storage.local (no SW round-trip,
//    works even if the SW is asleep): if a live window actually exists, hide the
//    overlay. Accepts a brief block→unblock flicker for an already-unlocked
//    reload — the right trade for a gating tool.
// 3. Ask the SW for authoritative state, which fills in the full challenge UI
//    (password/math/ceiling config) or confirms the unlock.

renderBlocked({
  platformLabel: '',
  passwordEnabled: false,
  passwordSet: false,
  mathEnabled: false,
  ceilingReached: false,
  _initial: true,
});

(async () => {
  try {
    const { blockState = {} } = await chrome.storage.local.get('blockState');
    const platform = self.SG_platformForUrl?.(location.href);
    const bs = platform ? blockState[platform] : null;
    const now = Date.now();
    const unlocked = bs && bs.unlockUntil && bs.unlockUntil > now;
    if (unlocked) renderUnlocked(bs);
  } catch {}
  chrome.runtime.sendMessage({ type: 'REQUEST_BLOCK_STATE' }).catch(() => {});
})();
