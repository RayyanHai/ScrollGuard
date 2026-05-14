// Popup logic.
//
// Reads from chrome.storage.local: today's sessions bucket, currentSessions,
// userConfig, blockState. Writes userConfig when saving settings. Talks to
// the SW only for actions that should be authoritative there: LOCK_NOW,
// RESET_TODAY. (Password change is just a userConfig write — verifying the
// CURRENT password happens here in the popup using the loaded config, since
// the popup is only opened by the user themselves.)

const GROUPS = [
  { key: 'scroll', label: 'Scroll' },
  { key: 'reels',  label: 'Reels' },
  { key: 'other',  label: 'Other' },
  { key: 'dm',     label: 'DMs' },
];

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

function todayDateKey() {
  const d = new Date();
  return `sessions:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function effectiveConfig(userConfig) {
  return {
    limits: { ...self.SG_CONFIG.limits, ...(userConfig.limits || {}) },
    contextToGroup: self.SG_CONFIG.contextToGroup,
    blockCooldownMs: userConfig.blockCooldownMs ?? self.SG_CONFIG.blockCooldownMs,
    passwordGraceMs: userConfig.passwordGraceMs ?? self.SG_CONFIG.passwordGraceMs,
    password: userConfig.password ?? self.SG_CONFIG.password,
  };
}

async function loadAll() {
  const dateKey = todayDateKey();
  const r = await chrome.storage.local.get([dateKey, 'currentSessions', 'userConfig', 'blockState']);
  return {
    sessions: r[dateKey] || [],
    currentSessions: r.currentSessions || {},
    userConfig: r.userConfig || {},
    blockState: r.blockState || {},
  };
}

// Sum activeMs from completed + in-flight sessions, grouped by limit-group.
// Untracked contexts (DMs) are summed under 'dm' for display.
function computeTotals(sessions, currentSessions, contextToGroup) {
  const totals = { scroll: 0, reels: 0, other: 0, dm: 0 };
  const allSegments = [];
  for (const s of sessions) for (const seg of s.segments) allSegments.push(seg);
  for (const s of Object.values(currentSessions)) for (const seg of s.segments) allSegments.push(seg);
  for (const seg of allSegments) {
    const grp = contextToGroup[seg.context];
    if (grp) totals[grp] += seg.activeMs;
    else totals.dm += seg.activeMs; // DMs are intentionally unblockable
  }
  return totals;
}

function classificationCounts(sessions) {
  const out = { quick_check: 0, browsing: 0, deep_scroll: 0 };
  for (const s of sessions) if (s.classification && out[s.classification] != null) out[s.classification]++;
  return out;
}

function inflightDescription(currentSessions) {
  const sessions = Object.values(currentSessions);
  if (!sessions.length) return null;
  // Show the most recently updated one. (In practice you have at most one IG
  // tab open, but if you have multiple, this picks the freshest.)
  const s = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];
  const seg = s.segments[s.segments.length - 1];
  if (!seg) return null;
  return { context: seg.context, activeMs: seg.activeMs };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// Threshold-based coloring on absolute usage (not relative to limit). The
// bar shows raw time spent, scaled to BAR_SCALE_MS so the visual fills as
// you spend more. Limits still drive the BLOCK overlay separately — they
// just don't appear in the popup display anymore.
const BAR_SCALE_MS = 45 * 60_000; // bar is fully filled at 45 min usage
const THRESH_WARN_MS = 15 * 60_000;
const THRESH_DANGER_MS = 30 * 60_000;

function severityForUsage(ms) {
  if (ms >= THRESH_DANGER_MS) return 'danger';
  if (ms >= THRESH_WARN_MS) return 'warn';
  return 'good';
}

function renderGroups(totals, cfg, blockState) {
  const root = document.getElementById('groups');
  root.innerHTML = '';
  const now = Date.now();

  for (const { key, label } of GROUPS) {
    const used = totals[key] || 0;
    const bs = blockState[key];
    const isBlocked = bs && bs.blockedUntil > now;
    const isUnlocked = isBlocked && bs.unlockUntil && bs.unlockUntil > now;

    // Default: usage-driven bar + threshold color.
    let pct = Math.min(100, (used / BAR_SCALE_MS) * 100);
    let fillClass = severityForUsage(used);
    let valueText = fmtMs(used);
    let rowMod = severityForUsage(used);

    // Override visuals for active block / unlock states. The countdown
    // takes priority over usage display because it's the actionable info.
    if (isBlocked && !isUnlocked) {
      pct = 100;
      fillClass = 'blocked';
      valueText = `🔒 ${fmtRemaining(bs.blockedUntil)}`;
      rowMod = 'blocked';
    } else if (isUnlocked) {
      pct = 100;
      fillClass = 'unlocked';
      valueText = `🔓 ${fmtRemaining(bs.unlockUntil)}`;
      rowMod = 'unlocked';
    }

    const row = document.createElement('div');
    row.className = 'group-row ' + rowMod;
    row.innerHTML = `
      <div class="name">${label}</div>
      <div class="bar"><div class="fill ${fillClass}" style="width:${pct}%"></div></div>
      <div class="value">${valueText}</div>
    `;
    root.appendChild(row);
  }
}

function renderMeta(sessions, currentSessions, totals) {
  const meta = document.getElementById('meta');
  meta.innerHTML = '';

  const sessionCount = sessions.length + Object.keys(currentSessions).length;
  const totalAll = Object.values(totals).reduce((a, b) => a + b, 0);
  const cls = classificationCounts(sessions);

  const summary = document.createElement('div');
  summary.innerHTML = `
    <span>${sessionCount} session${sessionCount === 1 ? '' : 's'}</span>
    <span class="dot">·</span>
    <span>${fmtMs(totalAll)} active</span>
  `;
  meta.appendChild(summary);

  // Classification breakdown on its own line. Hide zero-count buckets to
  // avoid showing "0 deep" early in the day.
  const parts = [];
  if (cls.quick_check) parts.push(`${cls.quick_check} quick`);
  if (cls.browsing)    parts.push(`${cls.browsing} browsing`);
  if (cls.deep_scroll) parts.push(`${cls.deep_scroll} deep`);
  if (parts.length) {
    const breakdown = document.createElement('div');
    breakdown.className = 'breakdown';
    breakdown.innerHTML = parts.map(p => `<span>${p}</span>`).join('<span class="dot">·</span>');
    meta.appendChild(breakdown);
  }

  const inflight = inflightDescription(currentSessions);
  if (inflight) {
    const cur = document.createElement('div');
    cur.className = 'currently';
    cur.innerHTML = `<span class="dim">Currently:</span> ${inflight.context} · <span class="dim">${fmtMs(inflight.activeMs)} active</span>`;
    meta.appendChild(cur);
  }
}

// Display a slider's current value in human-friendly form: seconds when <1 min,
// otherwise minutes (with .5 if fractional). The display is decorative — the
// actual saved value is parseFloat(slider.value) * 60000.
function fmtSliderValue(min) {
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (Number.isInteger(min)) return `${min} min`;
  return `${min.toFixed(1)} min`;
}

function updateValDisplay(id, min) {
  const el = document.getElementById(id + '-val');
  if (el) el.textContent = fmtSliderValue(min);
}

const SLIDER_IDS = ['lim-scroll', 'lim-reels', 'lim-other', 'cooldown', 'grace'];

function populateSettingsInputs(cfg) {
  const set = (id, ms) => {
    const min = +(ms / 60000).toFixed(2);
    const slider = document.getElementById(id);
    // Range inputs clamp to min/max — if a stored value exceeds the slider's
    // range, the slider will silently clamp on assign. Bump max if needed so
    // we don't lose user intent (rare; only matters if cfg has very large values).
    if (min > parseFloat(slider.max)) slider.max = String(min);
    slider.value = min;
    updateValDisplay(id, min);
  };
  set('lim-scroll', cfg.limits.scroll);
  set('lim-reels', cfg.limits.reels);
  set('lim-other', cfg.limits.other);
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

async function handleSave(currentCfg, currentUserConfig) {
  const parseMin = (id) => Math.round(parseFloat(document.getElementById(id).value) * 60000);

  const next = { ...currentUserConfig };
  next.limits = { ...(currentUserConfig.limits || {}) };
  next.limits.scroll = parseMin('lim-scroll');
  next.limits.reels  = parseMin('lim-reels');
  next.limits.other  = parseMin('lim-other');
  next.blockCooldownMs = parseMin('cooldown');
  next.passwordGraceMs = parseMin('grace');

  // Validate limits are positive
  for (const [k, v] of Object.entries(next.limits)) {
    if (!Number.isFinite(v) || v <= 0) {
      showMessage(`Invalid ${k} limit`, 'err');
      return;
    }
  }
  if (!Number.isFinite(next.blockCooldownMs) || next.blockCooldownMs <= 0) {
    showMessage('Invalid cooldown', 'err'); return;
  }
  if (!Number.isFinite(next.passwordGraceMs) || next.passwordGraceMs <= 0) {
    showMessage('Invalid grace', 'err'); return;
  }

  // Password change: require correct CURRENT password.
  const cur = document.getElementById('curPw').value;
  const newPw = document.getElementById('newPw').value;
  if (newPw) {
    if (cur !== currentCfg.password) {
      showMessage('Current password is wrong', 'err');
      return;
    }
    if (newPw.length < 4) {
      showMessage('New password too short (min 4 chars)', 'err');
      return;
    }
    next.password = newPw;
  }

  await chrome.storage.local.set({ userConfig: next });
  document.getElementById('curPw').value = '';
  document.getElementById('newPw').value = '';
  showMessage('Saved', 'ok');
}

async function handleLockNow() {
  if (!confirm('Lock all groups for the cooldown duration?')) return;
  await chrome.runtime.sendMessage({ type: 'LOCK_NOW' });
  refresh();
}

async function handleResetToday() {
  if (!confirm('Clear today\'s accumulated time and any active blocks?')) return;
  await chrome.runtime.sendMessage({ type: 'RESET_TODAY' });
  refresh();
}

// ---------------------------------------------------------------------------
// Refresh loop
// ---------------------------------------------------------------------------

let lastCfg = null;
let lastUserConfig = null;

async function refresh() {
  const { sessions, currentSessions, userConfig, blockState } = await loadAll();
  const cfg = effectiveConfig(userConfig);
  lastCfg = cfg;
  lastUserConfig = userConfig;

  const totals = computeTotals(sessions, currentSessions, cfg.contextToGroup);
  renderGroups(totals, cfg, blockState);
  renderMeta(sessions, currentSessions, totals);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// First-time setup view. Shown when userConfig.password isn't set. Required
// before the dashboard is reachable — keeps users from accidentally relying on
// a default password they didn't pick.
async function showSetupView() {
  document.getElementById('setupView').hidden = false;
  document.getElementById('mainView').hidden = true;

  const pw = document.getElementById('setupPw');
  const confirm = document.getElementById('setupPwConfirm');
  const msg = document.getElementById('setupMsg');
  const save = document.getElementById('setupSave');

  setTimeout(() => pw.focus(), 50);

  // Enter in either field submits.
  for (const el of [pw, confirm]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  }

  save.addEventListener('click', async () => {
    msg.textContent = '';
    msg.className = 'msg';
    const a = pw.value;
    const b = confirm.value;
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
    // Transition to main view. We re-run init logic from scratch since the
    // main view hasn't been populated yet.
    document.getElementById('setupView').hidden = true;
    document.getElementById('mainView').hidden = false;
    await initMain();
  });
}

async function initMain() {
  document.getElementById('date').textContent =
    new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  await refresh();
  populateSettingsInputs(lastCfg);
  wireSliderListeners();

  document.getElementById('toggleSettings').addEventListener('click', (e) => {
    const body = document.getElementById('settingsBody');
    body.hidden = !body.hidden;
    e.target.setAttribute('aria-expanded', String(!body.hidden));
    e.target.textContent = body.hidden ? 'edit' : 'close';
  });

  document.getElementById('save').addEventListener('click', async () => {
    await handleSave(lastCfg, lastUserConfig);
    // Reload so inputs reflect what was actually persisted (in case of clamping).
    await refresh();
    populateSettingsInputs(lastCfg);
  });

  document.getElementById('lockNow').addEventListener('click', handleLockNow);
  document.getElementById('resetToday').addEventListener('click', handleResetToday);

  // Refresh every second so countdowns and currently-in indicator stay live
  // while the popup is open.
  setInterval(refresh, 1000);
}

// Entry point: decide which view to show based on whether a password is set.
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
