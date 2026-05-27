// Popup logic (v3 — per-platform).
//
// Reads from chrome.storage.local: today's sessions bucket, currentSessions,
// userConfig, blockState ({ [platform]: ... }), dailyActive ({ [platform]: ... }).
// Writes userConfig when saving settings.
//
// Each tracked platform (from SG_PLATFORMS in lib/config.js) gets its own
// section in the dashboard with its own bar, meta, and lock/reset buttons.
// Settings (limit, cooldown, grace, password) are shared across all platforms.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtRemaining(ts) {
  return fmtMs(ts - Date.now());
}

function formatLocalDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayDateKey() {
  return `sessions:${formatLocalDate(Date.now())}`;
}

// Merge user-configured overrides on top of the SG_CONFIG defaults loaded
// from lib/config.js.
function effectiveConfig(userConfig) {
  const defaults = self.SG_CONFIG || {};
  return {
    limitMs: userConfig.limitMs ?? defaults.limitMs ?? 30 * 60_000,
    blockCooldownMs: userConfig.blockCooldownMs ?? defaults.blockCooldownMs ?? 30 * 60_000,
    passwordGraceMs: userConfig.passwordGraceMs ?? defaults.passwordGraceMs ?? 5 * 60_000,
    password: userConfig.password ?? defaults.password ?? null,
  };
}

function platforms() {
  return self.SG_PLATFORMS || [];
}

async function loadAll() {
  const dateKey = todayDateKey();
  const r = await chrome.storage.local.get([dateKey, 'currentSessions', 'userConfig', 'blockState', 'dailyActive']);
  return {
    sessions: r[dateKey] || [],
    currentSessions: r.currentSessions || {},
    userConfig: r.userConfig || {},
    blockState: r.blockState || {},
    dailyActive: r.dailyActive || {},
  };
}

// Older session shapes may lack `platform`. Default to instagram for legacy.
function sessionPlatform(s) {
  return s.platform || 'instagram';
}

function sessionActiveMs(s) {
  if (typeof s.activeMs === 'number') return s.activeMs;
  if (Array.isArray(s.segments)) {
    let sum = 0;
    for (const seg of s.segments) sum += (seg.activeMs || 0);
    return sum;
  }
  return 0;
}

// Authoritative source is dailyActive[platform].ms (maintained by the SW).
// Sessions are a fallback when dailyActive is missing/stale.
function computeTodayActiveMs(platformId, sessions, currentSessions, dailyActive) {
  const today = formatLocalDate(Date.now());
  const da = dailyActive[platformId];
  if (da && da.date === today && typeof da.ms === 'number') return da.ms;
  let sum = 0;
  for (const s of sessions) if (sessionPlatform(s) === platformId) sum += sessionActiveMs(s);
  for (const s of Object.values(currentSessions)) if (sessionPlatform(s) === platformId) sum += sessionActiveMs(s);
  return sum;
}

function classificationCounts(sessions, platformId) {
  const out = { quick_check: 0, browsing: 0, deep_scroll: 0 };
  for (const s of sessions) {
    if (sessionPlatform(s) !== platformId) continue;
    if (s.classification && out[s.classification] != null) out[s.classification]++;
  }
  return out;
}

function inflightForPlatform(currentSessions, platformId) {
  const list = Object.values(currentSessions).filter((s) => sessionPlatform(s) === platformId);
  if (!list.length) return null;
  const s = list.sort((a, b) => b.startedAt - a.startedAt)[0];
  return { activeMs: sessionActiveMs(s) };
}

function countSessions(sessions, currentSessions, platformId) {
  let n = 0;
  for (const s of sessions) if (sessionPlatform(s) === platformId) n++;
  for (const s of Object.values(currentSessions)) if (sessionPlatform(s) === platformId) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Render — per platform section
// ---------------------------------------------------------------------------

const THRESH_WARN_MS = 15 * 60_000;
const THRESH_DANGER_MS = 30 * 60_000;

function severity(usedMs) {
  if (usedMs >= THRESH_DANGER_MS) return 'danger';
  if (usedMs >= THRESH_WARN_MS) return 'warn';
  return 'good';
}

// Build the static DOM for one platform's dashboard section. Done once on
// init; the refresh loop only updates the live values inside.
function buildPlatformSection(platform) {
  const section = document.createElement('section');
  section.dataset.platform = platform.id;
  section.innerHTML = `
    <h2>${platform.label}</h2>
    <div class="platform-display">
      <div class="today-value" data-role="value">0:00</div>
      <div class="today-bar"><div class="today-fill" data-role="fill"></div></div>
      <div class="today-sub" data-role="sub"></div>
    </div>
    <div class="meta" data-role="meta"></div>
    <div class="platform-actions">
      <button class="ghost danger" data-action="lock">Lock me now</button>
      <button class="ghost" data-action="reset">Reset today</button>
    </div>
  `;

  section.querySelector('[data-action="lock"]').addEventListener('click', async () => {
    if (!confirm(`Lock ${platform.label} for the cooldown duration?`)) return;
    await chrome.runtime.sendMessage({ type: 'LOCK_NOW', platform: platform.id });
    refresh();
  });
  section.querySelector('[data-action="reset"]').addEventListener('click', async () => {
    if (!confirm(`Clear today's ${platform.label} time and any active block?`)) return;
    await chrome.runtime.sendMessage({ type: 'RESET_TODAY', platform: platform.id });
    refresh();
  });

  return section;
}

function renderPlatform(section, platform, usedMs, cfg, bs, sessions, currentSessions) {
  const valueEl = section.querySelector('[data-role="value"]');
  const fillEl = section.querySelector('[data-role="fill"]');
  const subEl = section.querySelector('[data-role="sub"]');
  const metaEl = section.querySelector('[data-role="meta"]');

  const now = Date.now();
  const isBlocked = bs && bs.blockedUntil && bs.blockedUntil > now;
  const isUnlocked = bs && bs.unlockUntil && bs.unlockUntil > now;

  let pct = cfg.limitMs > 0 ? Math.min(100, (usedMs / cfg.limitMs) * 100) : 0;
  let mod = severity(usedMs);
  let valueText = fmtMs(usedMs);

  if (isUnlocked) {
    pct = 100;
    mod = 'unlocked';
    valueText = `🔓 ${fmtRemaining(bs.unlockUntil)}`;
  } else if (isBlocked) {
    pct = 100;
    mod = 'blocked';
    valueText = `🔒 ${fmtRemaining(bs.blockedUntil)}`;
  }

  valueEl.textContent = valueText;
  valueEl.className = 'today-value ' + mod;
  fillEl.style.width = pct + '%';
  fillEl.className = 'today-fill ' + mod;

  const limitMin = Math.round(cfg.limitMs / 60_000);
  subEl.textContent = `of ${limitMin} min daily limit`;

  // Meta line.
  metaEl.innerHTML = '';
  const sessionCount = countSessions(sessions, currentSessions, platform.id);
  const cls = classificationCounts(sessions, platform.id);

  const summary = document.createElement('div');
  summary.innerHTML = `
    <span>${sessionCount} session${sessionCount === 1 ? '' : 's'}</span>
    <span class="dot">·</span>
    <span>${fmtMs(usedMs)} active</span>
  `;
  metaEl.appendChild(summary);

  const parts = [];
  if (cls.quick_check) parts.push(`${cls.quick_check} quick`);
  if (cls.browsing)    parts.push(`${cls.browsing} browsing`);
  if (cls.deep_scroll) parts.push(`${cls.deep_scroll} deep`);
  if (parts.length) {
    const breakdown = document.createElement('div');
    breakdown.className = 'breakdown';
    breakdown.innerHTML = parts.map(p => `<span>${p}</span>`).join('<span class="dot">·</span>');
    metaEl.appendChild(breakdown);
  }

  const inflight = inflightForPlatform(currentSessions, platform.id);
  if (inflight) {
    const cur = document.createElement('div');
    cur.className = 'currently';
    cur.innerHTML = `<span class="dim">Currently active:</span> ${fmtMs(inflight.activeMs)}`;
    metaEl.appendChild(cur);
  }
}

// ---------------------------------------------------------------------------
// Settings inputs (shared across platforms)
// ---------------------------------------------------------------------------

function fmtSliderValue(min) {
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (Number.isInteger(min)) return `${min} min`;
  return `${min.toFixed(1)} min`;
}

function updateValDisplay(id, min) {
  const el = document.getElementById(id + '-val');
  if (el) el.textContent = fmtSliderValue(min);
}

const SLIDER_IDS = ['lim-daily', 'cooldown', 'grace'];

function populateSettingsInputs(cfg) {
  const set = (id, ms) => {
    const min = +(ms / 60000).toFixed(2);
    const slider = document.getElementById(id);
    if (min > parseFloat(slider.max)) slider.max = String(min);
    slider.value = min;
    updateValDisplay(id, min);
  };
  set('lim-daily', cfg.limitMs);
  set('cooldown',  cfg.blockCooldownMs);
  set('grace',     cfg.passwordGraceMs);
}

function wireSliderListeners() {
  for (const id of SLIDER_IDS) {
    document.getElementById(id).addEventListener('input', (e) => {
      updateValDisplay(id, parseFloat(e.target.value));
    });
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function showMessage(text, kind) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
  if (kind === 'ok') {
    setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'msg'; } }, 2000);
  }
}

function setFieldErr(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg field-err' + (text ? ' err' : '');
}

function clearPwErrs() {
  setFieldErr('curPwErr', '');
  setFieldErr('newPwErr', '');
}

async function handleSave(currentCfg, currentUserConfig) {
  clearPwErrs();
  const parseMin = (id) => Math.round(parseFloat(document.getElementById(id).value) * 60000);

  const next = { ...currentUserConfig };
  delete next.limits;

  next.limitMs = parseMin('lim-daily');
  next.blockCooldownMs = parseMin('cooldown');
  next.passwordGraceMs = parseMin('grace');

  if (!Number.isFinite(next.limitMs) || next.limitMs <= 0) {
    showMessage('Invalid daily limit', 'err'); return;
  }
  if (!Number.isFinite(next.blockCooldownMs) || next.blockCooldownMs <= 0) {
    showMessage('Invalid cooldown', 'err'); return;
  }
  if (!Number.isFinite(next.passwordGraceMs) || next.passwordGraceMs <= 0) {
    showMessage('Invalid grace', 'err'); return;
  }

  const cur = document.getElementById('curPw').value;
  const newPw = document.getElementById('newPw').value;
  if (newPw) {
    let hasErr = false;
    if (!cur) {
      setFieldErr('curPwErr', 'Enter your current password');
      hasErr = true;
    } else if (cur !== currentCfg.password) {
      setFieldErr('curPwErr', 'Wrong current password');
      hasErr = true;
    }
    if (newPw.length < 4) {
      setFieldErr('newPwErr', 'New password too short (min 4)');
      hasErr = true;
    }
    if (hasErr) {
      showMessage('Fix password errors above', 'err');
      return;
    }
    next.password = newPw;
  } else if (cur) {
    setFieldErr('newPwErr', 'Enter a new password, or clear both fields');
    showMessage('Fix password errors above', 'err');
    return;
  }

  await chrome.storage.local.set({ userConfig: next });
  document.getElementById('curPw').value = '';
  document.getElementById('newPw').value = '';
  clearPwErrs();
  showMessage('Saved', 'ok');
}

// ---------------------------------------------------------------------------
// Refresh loop
// ---------------------------------------------------------------------------

let lastCfg = null;
let lastUserConfig = null;

async function refresh() {
  const { sessions, currentSessions, userConfig, blockState, dailyActive } = await loadAll();
  const cfg = effectiveConfig(userConfig);
  lastCfg = cfg;
  lastUserConfig = userConfig;

  for (const platform of platforms()) {
    const section = document.querySelector(`section[data-platform="${platform.id}"]`);
    if (!section) continue;
    const usedMs = computeTodayActiveMs(platform.id, sessions, currentSessions, dailyActive);
    const bs = blockState[platform.id] || null;
    renderPlatform(section, platform, usedMs, cfg, bs, sessions, currentSessions);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function showSetupView() {
  document.getElementById('setupView').hidden = false;
  document.getElementById('mainView').hidden = true;

  const pw = document.getElementById('setupPw');
  const confirmEl = document.getElementById('setupPwConfirm');
  const msg = document.getElementById('setupMsg');
  const save = document.getElementById('setupSave');

  setTimeout(() => pw.focus(), 50);

  for (const el of [pw, confirmEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  }

  save.addEventListener('click', async () => {
    msg.textContent = '';
    msg.className = 'msg';
    const a = pw.value;
    const b = confirmEl.value;
    if (!a || a.length < 4) {
      msg.textContent = 'Password must be at least 4 characters.';
      msg.className = 'msg err';
      return;
    }
    if (a !== b) {
      msg.textContent = 'Passwords don\'t match.';
      msg.className = 'msg err';
      return;
    }
    const current = await chrome.storage.local.get('userConfig');
    const userConfig = current.userConfig || {};
    userConfig.password = a;
    await chrome.storage.local.set({ userConfig });
    document.getElementById('setupView').hidden = true;
    document.getElementById('mainView').hidden = false;
    await initMain();
  });
}

async function initMain() {
  document.getElementById('date').textContent =
    new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  // Build one section per tracked platform.
  const container = document.getElementById('platformSections');
  container.innerHTML = '';
  for (const platform of platforms()) {
    container.appendChild(buildPlatformSection(platform));
  }

  await refresh();
  populateSettingsInputs(lastCfg);
  wireSliderListeners();

  document.getElementById('toggleSettings').addEventListener('click', (e) => {
    const body = document.getElementById('settingsBody');
    body.hidden = !body.hidden;
    e.target.setAttribute('aria-expanded', String(!body.hidden));
    e.target.textContent = body.hidden ? 'edit' : 'close';
  });

  document.getElementById('curPw').addEventListener('input', () => setFieldErr('curPwErr', ''));
  document.getElementById('newPw').addEventListener('input', () => setFieldErr('newPwErr', ''));

  document.getElementById('save').addEventListener('click', async () => {
    await handleSave(lastCfg, lastUserConfig);
    await refresh();
    populateSettingsInputs(lastCfg);
  });

  // Refresh every second so countdowns and currently-active indicator stay
  // live while the popup is open.
  setInterval(refresh, 1000);
}

async function init() {
  const { userConfig = {} } = await chrome.storage.local.get('userConfig');
  if (!userConfig.password) {
    await showSetupView();
  } else {
    document.getElementById('mainView').hidden = false;
    await initMain();
  }
}

init();
