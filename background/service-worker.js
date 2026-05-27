// ScrollGuard service worker (v3 — per-platform).
//
// Pipeline at a glance:
//   nav events → per-tab session tracking → 30s alarm tick →
//   per-platform dailyActive counter (auto-resets at midnight AND after each
//   block cooldown) → limit check → per-platform block state →
//   BLOCK/UNLOCK/CLEAR to that platform's content scripts
//
// State buckets (all keyed by platform id where it matters):
//   tabSessions       in-memory (mirrored to storage as 'currentSessions')
//                     each session has a `platform` field
//   tabState          in-memory only (cheap to rebuild from chrome APIs)
//   tabPlatform       in-memory: tabId → platform id (or null)
//   dailyActive       storage: { [platform]: { date, ms } }
//   blockState        storage: { [platform]: { blockedUntil, unlockUntil } | null }
//   lastTickAt        storage: persisted across SW restarts
//
// Key v3 changes:
//   - Multi-platform: Instagram + TikTok, with the abstraction in place to add
//     more later. Each platform has its own daily counter and own block.
//   - Counter resets to 0 when that platform's block cooldown EXPIRES (not just
//     at midnight). Cooldown is the punishment; once it's done, you start
//     fresh. Fixes the "blocks me again later in the day" bug.
//   - Sessions carry a `platform` field so the dashboard can split per-platform.

importScripts('/lib/storage.js', '/lib/config.js');

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {number} tabId
 * @property {string} platform     - platform id ('instagram', 'tiktok', ...)
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {number} activeMs
 * @property {number} passiveMs
 * @property {'quick_check'|'browsing'|'deep_scroll'|null} classification
 */

/** @type {Map<number, Session>} tabId → in-flight session */
const tabSessions = new Map();
/** @type {Map<number, {windowId:number, isActiveInWindow:boolean, isVisible:boolean}>} */
const tabState = new Map();
/** @type {Map<number, string>} tabId → platform id (cached so we don't re-parse URL) */
const tabPlatform = new Map();
let focusedWindowId = null;

// Wall-clock of the last tick we processed. Persisted to storage so that when
// the SW dies and the next alarm fires, we can charge the elapsed wall time
// to the appropriate counters (clamped to 60s — see tick()).
let lastTickAt = Date.now();

// Per-platform daily counters. Lazily ensure each platform has an entry.
// Shape: { [platformId]: { date: 'YYYY-MM-DD', ms: number } }
let dailyActive = {};

// Per-platform block state. Shape: { [platformId]: { blockedUntil, unlockUntil } | null }
let blockState = {};

// Per-tab last-sent overlay mode, so we don't spam messages each tick.
// 'hidden' | 'blocked' | 'unlocked'
const lastOverlayState = new Map();

// User-edited config from chrome.storage.local 'userConfig'. Layered ON TOP
// of the hardcoded SG_CONFIG defaults — anything missing falls through.
let userConfig = {};

function cfg() {
  return {
    limitMs: userConfig.limitMs ?? self.SG_CONFIG.limitMs,
    blockCooldownMs: userConfig.blockCooldownMs ?? self.SG_CONFIG.blockCooldownMs,
    passwordGraceMs: userConfig.passwordGraceMs ?? self.SG_CONFIG.passwordGraceMs,
    password: userConfig.password ?? self.SG_CONFIG.password,
  };
}

function platformIds() {
  return self.SG_PLATFORMS.map((p) => p.id);
}

function platformLabel(id) {
  return self.SG_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}

// Local-time YYYY-MM-DD string. Used for `dailyActive[*].date` AND for the
// `sessions:YYYY-MM-DD` storage key. Local (not UTC) because "today" should
// mean the user's wall calendar, not a UTC day.
function formatLocalDate(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ensurePlatformBuckets() {
  const today = formatLocalDate();
  for (const id of platformIds()) {
    if (!dailyActive[id]) dailyActive[id] = { date: today, ms: 0 };
    if (!(id in blockState)) blockState[id] = null;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.userConfig) {
    userConfig = changes.userConfig.newValue ?? {};
    console.log('[SG] userConfig updated');
  }
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function newSession(tabId, platform, ts) {
  return {
    id: crypto.randomUUID(),
    tabId,
    platform,
    startedAt: ts,
    endedAt: null,
    activeMs: 0,
    passiveMs: 0,
    classification: null,
  };
}

// Classify on session end. Total wall duration only; we don't slice it up by
// active-vs-passive here because the classification is a coarse summary for
// the dashboard ("did I just check it or did I doomscroll?").
function classifySession(s) {
  const total = (s.endedAt ?? Date.now()) - s.startedAt;
  if (total < 60_000) return 'quick_check';
  if (total < 5 * 60_000) return 'browsing';
  return 'deep_scroll';
}

async function persistCurrent() {
  const obj = {};
  for (const [tid, s] of tabSessions) obj[tid] = s;
  await SGStorage.set('currentSessions', obj);
  await SGStorage.set('dailyActive', dailyActive);
  await SGStorage.set('lastTickAt', lastTickAt);
}

async function persistBlockState() {
  await SGStorage.set('blockState', blockState);
}

async function endSession(tabId, reason) {
  const session = tabSessions.get(tabId);
  if (!session) return;
  const now = Date.now();
  session.endedAt = now;
  session.classification = classifySession(session);
  console.log('[SG]', session.platform, 'session ended:', reason, '|', session.classification, '|', Math.round((session.activeMs + session.passiveMs) / 1000) + 's total');

  // Bucket by the local date of when the session STARTED. This keeps a session
  // that crossed midnight in the day it began — simpler to reason about than
  // splitting it, and accurate enough for a daily dashboard.
  const key = SGStorage.dateKey(session.startedAt);
  await SGStorage.update(key, [], (arr) => { arr.push(session); return arr; });

  tabSessions.delete(tabId);
  tabState.delete(tabId);
  tabPlatform.delete(tabId);
  lastOverlayState.delete(tabId);
  await persistCurrent();
}

async function onTrackedNavigation(tabId, platform) {
  const now = Date.now();
  tabPlatform.set(tabId, platform);
  const existing = tabSessions.get(tabId);
  if (existing && existing.platform !== platform) {
    // Tab moved between tracked platforms (rare — same tab navigates from
    // instagram.com to tiktok.com). Close the old session before starting fresh.
    await endSession(tabId, 'platform-switch');
  }
  if (!tabSessions.has(tabId)) {
    const session = newSession(tabId, platform, now);
    tabSessions.set(tabId, session);
    console.log('[SG]', platform, 'session started: tab', tabId);
    await persistCurrent();
  }
}

// ---------------------------------------------------------------------------
// Navigation listeners
// ---------------------------------------------------------------------------

// Build webNavigation URL filter from configured platforms. The filter
// supports an array of host-suffix matches; we register one per platform.
const navFilter = {
  url: self.SG_PLATFORMS.map((p) => ({ hostSuffix: p.hostSuffix })),
};

async function handleNav(details) {
  if (details.frameId !== 0) return;
  const platform = self.SG_platformForUrl(details.url);
  if (!platform) return;

  const st = tabState.get(details.tabId) ?? { isActiveInWindow: false, isVisible: false };
  try {
    const tab = await chrome.tabs.get(details.tabId);
    st.windowId = tab.windowId;
    st.isActiveInWindow = tab.active;
  } catch {}
  tabState.set(details.tabId, st);
  await onTrackedNavigation(details.tabId, platform);

  // Send overlay state immediately on every nav (including reloads), not on
  // the next 30s alarm. Closes the visible gap when reloading a blocked
  // page. The .catch swallows the case where the content script isn't ready
  // yet — its own REQUEST_BLOCK_STATE on load is the backup path.
  const target = evaluateOverlay(platform, Date.now());
  sendOverlay(details.tabId, platform, target);
  lastOverlayState.set(details.tabId, target.mode);
}

chrome.webNavigation.onCommitted.addListener(handleNav, navFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNav, navFilter);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 'loading' fires before the URL has fully changed in some cases, but it
  // is the earliest reliable signal that the user is leaving the page.
  if (changeInfo.status !== 'loading') return;
  if (!tabSessions.has(tabId)) return;
  if (!self.SG_platformForUrl(tab.url)) await endSession(tabId, 'navigated-away');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabSessions.has(tabId)) await endSession(tabId, 'tab-closed');
  tabState.delete(tabId);
  tabPlatform.delete(tabId);
  lastOverlayState.delete(tabId);
});

// ---------------------------------------------------------------------------
// Focus / visibility
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Within a window, exactly one tab is active. Flip the flag so the previous
  // active tab stops accumulating and the new one starts.
  for (const [tid, st] of tabState) {
    if (st.windowId === windowId) st.isActiveInWindow = (tid === tabId);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  focusedWindowId = (windowId === chrome.windows.WINDOW_ID_NONE) ? null : windowId;
});

// ---------------------------------------------------------------------------
// Block evaluation
// ---------------------------------------------------------------------------

// All three signals must agree before we count a tab as "actively viewed":
//   - it's the active tab in its window
//   - its document.visibilityState is 'visible' (content script tells us)
//   - its window is the OS-focused one
function isActivelyViewing(tabId) {
  const st = tabState.get(tabId);
  if (!st) return false;
  return st.isActiveInWindow === true
      && st.isVisible === true
      && st.windowId === focusedWindowId;
}

// Returns the overlay state a tab on `platform` should be in right now.
function evaluateOverlay(platform, now) {
  const bs = blockState[platform];
  if (!bs || bs.blockedUntil <= now) return { mode: 'hidden' };
  if (bs.unlockUntil && bs.unlockUntil > now) {
    return {
      mode: 'unlocked',
      blockedUntil: bs.blockedUntil,
      unlockUntil: bs.unlockUntil,
    };
  }
  return { mode: 'blocked', blockedUntil: bs.blockedUntil };
}

function sendOverlay(tabId, platform, evalResult) {
  // Tell the content script whether a password is configured. When false,
  // the overlay swaps the unlock input for a "set up in the popup" message.
  const passwordSet = !!cfg().password;
  const label = platformLabel(platform);
  if (evalResult.mode === 'blocked') {
    chrome.tabs.sendMessage(tabId, {
      type: 'BLOCK',
      platform,
      platformLabel: label,
      blockedUntil: evalResult.blockedUntil,
      passwordSet,
    }).catch(() => {});
  } else if (evalResult.mode === 'unlocked') {
    chrome.tabs.sendMessage(tabId, {
      type: 'UNLOCK',
      platform,
      unlockUntil: evalResult.unlockUntil,
    }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR', platform }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The tick (chrome.alarms-driven, ~30s cadence)
// ---------------------------------------------------------------------------

async function tick() {
  const now = Date.now();

  // Clamp elapsed to [0, 60_000].
  const elapsed = Math.min(Math.max(0, now - lastTickAt), 60_000);
  lastTickAt = now;

  // Daily reset BEFORE accumulating, so the first tick of a new day starts
  // each platform's counter at zero.
  const today = formatLocalDate(now);
  for (const id of platformIds()) {
    if (!dailyActive[id]) dailyActive[id] = { date: today, ms: 0 };
    if (dailyActive[id].date !== today) {
      console.log('[SG]', id, 'daily reset:', dailyActive[id].date, '→', today);
      dailyActive[id] = { date: today, ms: 0 };
    }
  }

  let blockChanged = false;

  // Accumulate per in-flight session. Active time charges the platform's
  // daily counter; passive time only logs against the session.
  for (const [tabId, session] of tabSessions) {
    const active = isActivelyViewing(tabId);
    if (elapsed > 0) {
      if (active) {
        session.activeMs += elapsed;
        const da = dailyActive[session.platform];
        if (da) da.ms += elapsed;
      } else {
        session.passiveMs += elapsed;
      }
    }
  }

  const c = cfg();

  // Per-platform limit / expiry check.
  for (const id of platformIds()) {
    const bs = blockState[id];
    const da = dailyActive[id];

    // Trigger new block on limit hit.
    if (da && da.ms >= c.limitMs && (!bs || bs.blockedUntil <= now)) {
      blockState[id] = { blockedUntil: now + c.blockCooldownMs, unlockUntil: null };
      blockChanged = true;
      console.log('[SG]', id, 'LIMIT HIT — blocked until', new Date(blockState[id].blockedUntil).toLocaleTimeString());
    }

    // Expire blocks AND reset that platform's daily counter. The cooldown IS
    // the punishment; once it ends, you start with a clean budget. Without
    // this reset, the counter stays at the limit and re-blocks instantly the
    // moment you open the site again later in the day.
    if (blockState[id] && blockState[id].blockedUntil <= now) {
      blockState[id] = null;
      dailyActive[id] = { date: today, ms: 0 };
      blockChanged = true;
      console.log('[SG]', id, 'block expired — counter reset to 0');
    }
  }

  // Push overlay state to every in-flight tracked tab. Only re-send if the
  // mode changed for that tab (or any block changed, which forces a re-send
  // to be safe).
  for (const [tabId, session] of tabSessions) {
    const target = evaluateOverlay(session.platform, now);
    const last = lastOverlayState.get(tabId);
    if (last !== target.mode || blockChanged) {
      sendOverlay(tabId, session.platform, target);
      lastOverlayState.set(tabId, target.mode);
    }
  }

  await persistCurrent();
  if (blockChanged) await persistBlockState();
}

chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') tick();
});

// ---------------------------------------------------------------------------
// Messages from content scripts and popup
// ---------------------------------------------------------------------------

// Resolve which platform a sender belongs to. Tries the cached map first,
// then the tab's URL as a fallback. Returns null if the sender isn't a
// tracked tab (e.g. messages from the popup with no tab attached).
function platformForSender(sender) {
  const tabId = sender.tab?.id;
  if (tabId != null && tabPlatform.has(tabId)) return tabPlatform.get(tabId);
  if (sender.tab?.url) return self.SG_platformForUrl(sender.tab.url);
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg?.type === 'VISIBILITY') {
    if (tabId == null) return;
    const st = tabState.get(tabId) ?? {
      windowId: sender.tab.windowId,
      isActiveInWindow: sender.tab.active ?? false,
    };
    st.isVisible = !!msg.visible;
    if (st.windowId == null) st.windowId = sender.tab.windowId;
    tabState.set(tabId, st);
    return;
  }

  if (msg?.type === 'TRY_UNLOCK') {
    // Unlocks are scoped to the platform of the tab the user typed into.
    const platform = platformForSender(sender);
    const c = cfg();
    const ok = !!c.password && msg.password === c.password && platform != null;
    if (ok && tabId != null) {
      const now = Date.now();
      const bs = blockState[platform];
      if (bs && bs.blockedUntil > now) {
        bs.unlockUntil = now + c.passwordGraceMs;
        persistBlockState().then(() => {
          sendOverlay(tabId, platform, evaluateOverlay(platform, Date.now()));
          lastOverlayState.set(tabId, 'unlocked');
          sendResponse({ ok: true });
        });
        console.log('[SG]', platform, 'unlocked for', c.passwordGraceMs / 1000, 's');
        return true; // async sendResponse
      }
      sendResponse({ ok: true });
      return true;
    }
    if (!ok) console.log('[SG] wrong password attempted on', platform);
    sendResponse({ ok });
    return true;
  }

  if (msg?.type === 'LOCK_NOW') {
    // Popup sends `platform`; lock just that one.
    const platform = msg.platform;
    if (!platformIds().includes(platform)) {
      sendResponse({ ok: false });
      return true;
    }
    const c = cfg();
    const now = Date.now();
    blockState[platform] = { blockedUntil: now + c.blockCooldownMs, unlockUntil: null };
    persistBlockState();
    console.log('[SG] LOCK_NOW', platform, 'until', new Date(blockState[platform].blockedUntil).toLocaleTimeString());
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'RESET_TODAY') {
    // Popup sends `platform`; reset just that one (counter + block).
    const platform = msg.platform;
    if (!platformIds().includes(platform)) {
      sendResponse({ ok: false });
      return true;
    }
    dailyActive[platform] = { date: formatLocalDate(), ms: 0 };
    blockState[platform] = null;
    persistBlockState();
    persistCurrent();
    console.log('[SG] RESET_TODAY', platform);
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'REQUEST_BLOCK_STATE') {
    if (tabId == null) return;
    const platform = platformForSender(sender);
    if (!platform) return;
    sendOverlay(tabId, platform, evaluateOverlay(platform, Date.now()));
    return;
  }
});

// ---------------------------------------------------------------------------
// SW startup / restart recovery
// ---------------------------------------------------------------------------

(async () => {
  // Seed which OS window is currently focused so the first tick has a chance
  // of being correct.
  try {
    const win = await chrome.windows.getLastFocused();
    focusedWindowId = win.focused ? win.id : null;
    console.log('[SG] seeded focusedWindowId =', focusedWindowId);
  } catch {}

  // --- One-shot v1 cleanup (kept harmless if already done) ---
  await SGStorage.remove('bucketActiveMs');

  // Load persisted state.
  userConfig = await SGStorage.get('userConfig', {});

  // v1 userConfig may have a `limits` field (scroll/reels/other); strip it.
  if (userConfig && typeof userConfig === 'object' && 'limits' in userConfig) {
    const { limits, contextToGroup, ...rest } = userConfig;
    userConfig = rest;
    await SGStorage.set('userConfig', userConfig);
    console.log('[SG] migrated userConfig (removed legacy limits/contextToGroup)');
  }

  // dailyActive migration: v2 stored a single { date, ms } (Instagram only).
  // v3 stores { [platform]: { date, ms } }. Detect the old shape and migrate.
  const rawDaily = await SGStorage.get('dailyActive', null);
  if (rawDaily && typeof rawDaily === 'object' && typeof rawDaily.ms === 'number' && typeof rawDaily.date === 'string') {
    console.log('[SG] migrating v2 dailyActive → per-platform shape');
    dailyActive = { instagram: rawDaily };
  } else if (rawDaily && typeof rawDaily === 'object') {
    dailyActive = rawDaily;
  } else {
    dailyActive = {};
  }

  // blockState migration: v2 stored a single { blockedUntil, unlockUntil } | null.
  // v3 stores { [platform]: ... | null }.
  const rawBlock = await SGStorage.get('blockState', null);
  if (rawBlock && typeof rawBlock === 'object' && 'blockedUntil' in rawBlock) {
    console.log('[SG] migrating v2 blockState → per-platform shape');
    blockState = { instagram: rawBlock };
  } else if (rawBlock && typeof rawBlock === 'object') {
    blockState = rawBlock;
  } else {
    blockState = {};
  }

  ensurePlatformBuckets();

  // Normalize stale dates per platform.
  const today = formatLocalDate();
  for (const id of platformIds()) {
    if (dailyActive[id].date !== today) dailyActive[id] = { date: today, ms: 0 };
  }

  // Persist the migrated shape so subsequent reads are clean.
  await SGStorage.set('dailyActive', dailyActive);
  await SGStorage.set('blockState', blockState);

  // lastTickAt is persisted so the first post-restart tick charges the
  // elapsed wall time (capped to 60s) rather than zero.
  lastTickAt = await SGStorage.get('lastTickAt', Date.now());

  const saved = await SGStorage.get('currentSessions', {});
  for (const [tid, s] of Object.entries(saved)) {
    // Older sessions may lack a `platform` field — assume Instagram.
    if (!s.platform) s.platform = 'instagram';
    tabSessions.set(Number(tid), s);
    tabPlatform.set(Number(tid), s.platform);
  }
  if (tabSessions.size) {
    console.log('[SG] restored', tabSessions.size, 'in-flight session(s)');
    for (const tabId of tabSessions.keys()) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabState.set(tabId, {
          windowId: tab.windowId,
          isActiveInWindow: tab.active,
          isVisible: false,
        });
      } catch {
        await endSession(tabId, 'tab-gone-on-restart');
      }
    }
  }

  chrome.alarms.create('tick', { periodInMinutes: 0.5 });
})();

console.log('[SG] service worker started');
