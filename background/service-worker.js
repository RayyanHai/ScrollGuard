// ScrollGuard service worker (v3 — earn-to-scroll, per-platform).
//
// Model is INVERTED vs earlier versions: tracked platforms are BLOCKED by
// default. The only way in is to pass a challenge (password or math set) that
// grants a fixed wall-clock scroll window. Grants don't stack; each pass opens
// a fresh window. An optional per-platform daily ceiling caps ACTIVE scroll
// time; once hit, unlocks are refused until midnight.
//
// Pipeline at a glance:
//   nav events → per-tab session tracking → 30s alarm tick →
//   accrue active time ONLY while a platform's window is live →
//   ceiling check (cut window short if hit) + window expiry →
//   BLOCK/UNLOCK/CLEAR to that platform's content scripts
//
// State buckets (all keyed by platform id where it matters):
//   tabSessions       in-memory (mirrored to storage as 'currentSessions')
//                     each session has a `platform` field
//   tabState          in-memory only (cheap to rebuild from chrome APIs)
//   tabPlatform       in-memory: tabId → platform id (or null)
//   dailyActive       storage: { [platform]: { date, ms } } — active scroll time used today
//   blockState        storage: { [platform]: { unlockUntil } | null } — null/past = LOCKED
//   lastTickAt        storage: persisted across SW restarts
//
// In-flight math challenges live in chrome.storage.session keyed by tabId, so a
// correct answer submitted after the SW was killed still validates.

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

// Per-platform block state. Shape: { [platformId]: { unlockUntil } | null }.
// null / past unlockUntil = LOCKED (the default). A live unlockUntil = a scroll window.
let blockState = {};

// Per-tab last-sent overlay mode, so we don't spam messages each tick.
// 'hidden' | 'blocked' | 'unlocked'
const lastOverlayState = new Map();

// User-edited config from chrome.storage.local 'userConfig'. Layered ON TOP
// of the hardcoded SG_CONFIG defaults — anything missing falls through.
let userConfig = {};

function cfg() {
  const d = self.SG_CONFIG;
  return {
    passwordEnabled: userConfig.passwordEnabled ?? d.passwordEnabled,
    password: userConfig.password ?? d.password,
    passwordGrantMs: userConfig.passwordGrantMs ?? d.passwordGrantMs,
    mathEnabled: userConfig.mathEnabled ?? d.mathEnabled,
    mathCount: userConfig.mathCount ?? d.mathCount,
    mathDifficulty: userConfig.mathDifficulty ?? d.mathDifficulty,
    mathGrantMs: userConfig.mathGrantMs ?? d.mathGrantMs,
    dailyCeilingMs: userConfig.dailyCeilingMs ?? d.dailyCeilingMs,
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

// True when the platform has already spent its daily active-scroll budget.
// A ceiling of 0 means "no cap". Only counts today's usage.
function ceilingReached(platform, now = Date.now()) {
  const c = cfg();
  if (!c.dailyCeilingMs || c.dailyCeilingMs <= 0) return false;
  const da = dailyActive[platform];
  if (!da || da.date !== formatLocalDate(now)) return false;
  return da.ms >= c.dailyCeilingMs;
}

// Returns the overlay state a tab on `platform` should be in right now.
// Default is BLOCKED — a tab is only unlocked while a live window exists.
// Legacy `blockedUntil` fields (from the old cooldown model) are ignored.
function evaluateOverlay(platform, now) {
  const bs = blockState[platform];
  if (bs && bs.unlockUntil && bs.unlockUntil > now) {
    return { mode: 'unlocked', unlockUntil: bs.unlockUntil };
  }
  return { mode: 'blocked', ceilingReached: ceilingReached(platform, now) };
}

function sendOverlay(tabId, platform, evalResult) {
  const c = cfg();
  const label = platformLabel(platform);
  if (evalResult.mode === 'unlocked') {
    chrome.tabs.sendMessage(tabId, {
      type: 'UNLOCK',
      platform,
      unlockUntil: evalResult.unlockUntil,
    }).catch(() => {});
  } else {
    // Blocked (the default). Ship the challenge config so the overlay can
    // render the password field and/or the math option without a round-trip.
    chrome.tabs.sendMessage(tabId, {
      type: 'BLOCK',
      platform,
      platformLabel: label,
      passwordEnabled: c.passwordEnabled && !!c.password,
      passwordSet: !!c.password,
      mathEnabled: c.mathEnabled,
      mathCount: c.mathCount,
      mathDifficulty: c.mathDifficulty,
      ceilingReached: evalResult.ceilingReached ?? ceilingReached(platform, Date.now()),
    }).catch(() => {});
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

  // Helper: is this platform currently inside a live scroll window?
  const isUnlocked = (id) => {
    const bs = blockState[id];
    return !!(bs && bs.unlockUntil && bs.unlockUntil > now);
  };

  // Accumulate per in-flight session. Active time only charges the daily
  // counter while the platform is UNLOCKED — time spent staring at the block
  // overlay must not burn the daily ceiling. Passive time only logs against
  // the session.
  for (const [tabId, session] of tabSessions) {
    const active = isActivelyViewing(tabId);
    if (elapsed > 0) {
      if (active) {
        session.activeMs += elapsed;
        if (isUnlocked(session.platform)) {
          const da = dailyActive[session.platform];
          if (da) da.ms += elapsed;
        }
      } else {
        session.passiveMs += elapsed;
      }
    }
  }

  // Per-platform window maintenance.
  for (const id of platformIds()) {
    const bs = blockState[id];
    if (!bs || !bs.unlockUntil) continue;

    // Cut the window short if the daily ceiling was hit mid-scroll.
    if (bs.unlockUntil > now && ceilingReached(id, now)) {
      blockState[id] = { unlockUntil: null };
      blockChanged = true;
      console.log('[SG]', id, 'daily ceiling reached — window cut short');
      continue;
    }

    // Window expired → back to locked (default).
    if (bs.unlockUntil <= now) {
      blockState[id] = { unlockUntil: null };
      blockChanged = true;
      console.log('[SG]', id, 'scroll window expired — locked');
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

// Open a fresh scroll window on `platform` and push the unlocked overlay to the
// tab that earned it. Grants don't stack — this always replaces the window.
async function grantWindow(tabId, platform, grantMs) {
  const now = Date.now();
  blockState[platform] = { unlockUntil: now + grantMs };
  await persistBlockState();
  sendOverlay(tabId, platform, evaluateOverlay(platform, Date.now()));
  lastOverlayState.set(tabId, 'unlocked');
  console.log('[SG]', platform, 'unlocked for', Math.round(grantMs / 1000), 's');
}

// In-flight math challenges live in chrome.storage.session (survives SW death).
// Keyed per tab so each blocked tab has its own set.
const challengeKey = (tabId) => `mathChallenge:${tabId}`;

async function saveChallenge(tabId, platform, problems) {
  await chrome.storage.session.set({
    [challengeKey(tabId)]: { platform, problems, createdAt: Date.now() },
  });
}
async function loadChallenge(tabId) {
  const k = challengeKey(tabId);
  const obj = await chrome.storage.session.get(k);
  return obj[k] ?? null;
}
async function clearChallenge(tabId) {
  await chrome.storage.session.remove(challengeKey(tabId));
}

// Strip the answers before a problem set crosses into a content script.
const publicProblems = (problems) => problems.map(({ a, b, op }) => ({ a, b, op }));

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
    // Password path. Scoped to the platform of the tab the user typed into.
    const platform = platformForSender(sender);
    const c = cfg();
    if (ceilingReached(platform)) {
      sendResponse({ ok: false, ceiling: true });
      return true;
    }
    const ok = c.passwordEnabled && !!c.password && msg.password === c.password && platform != null;
    if (ok && tabId != null) {
      grantWindow(tabId, platform, c.passwordGrantMs).then(() => sendResponse({ ok: true }));
      return true; // async sendResponse
    }
    if (!ok) console.log('[SG] wrong password attempted on', platform);
    sendResponse({ ok });
    return true;
  }

  if (msg?.type === 'REQUEST_MATH_CHALLENGE') {
    const platform = platformForSender(sender);
    const c = cfg();
    if (tabId == null || platform == null || !c.mathEnabled) {
      sendResponse({ ok: false });
      return true;
    }
    if (ceilingReached(platform)) {
      sendResponse({ ok: false, ceiling: true });
      return true;
    }
    const problems = self.SG_makeMathSet(c.mathCount, c.mathDifficulty);
    saveChallenge(tabId, platform, problems).then(() => {
      sendResponse({ ok: true, problems: publicProblems(problems) });
    });
    return true; // async sendResponse
  }

  if (msg?.type === 'SUBMIT_MATH') {
    const platform = platformForSender(sender);
    const c = cfg();
    if (tabId == null || platform == null) {
      sendResponse({ ok: false });
      return true;
    }
    if (ceilingReached(platform)) {
      clearChallenge(tabId);
      sendResponse({ ok: false, ceiling: true });
      return true;
    }
    loadChallenge(tabId).then(async (stored) => {
      // Lost the challenge (SW slept before storage.session was seeded, or a
      // stale submit). Tell the content script to request a new set.
      if (!stored || !Array.isArray(stored.problems) || stored.platform !== platform) {
        sendResponse({ ok: false, expired: true });
        return;
      }
      const answers = Array.isArray(msg.answers) ? msg.answers : [];
      const problems = stored.problems;
      let wrongCount = 0;
      for (let i = 0; i < problems.length; i++) {
        const a = answers[i];
        // Blank or non-numeric counts as wrong (don't let empty match a 0-answer).
        if (a === null || a === undefined || a === '' || Number(a) !== problems[i].answer) wrongCount++;
      }
      if (wrongCount === 0 && answers.length === problems.length) {
        await clearChallenge(tabId);
        await grantWindow(tabId, platform, c.mathGrantMs);
        sendResponse({ ok: true });
        return;
      }
      // Any wrong → regenerate a fresh set so the same problems can't be
      // brute-forced by resubmitting.
      const fresh = self.SG_makeMathSet(c.mathCount, c.mathDifficulty);
      await saveChallenge(tabId, platform, fresh);
      sendResponse({ ok: false, wrongCount, problems: publicProblems(fresh) });
    });
    return true; // async sendResponse
  }

  if (msg?.type === 'LOCK_NOW') {
    // Popup sends `platform`; end its scroll window now (back to locked).
    const platform = msg.platform;
    if (!platformIds().includes(platform)) {
      sendResponse({ ok: false });
      return true;
    }
    blockState[platform] = { unlockUntil: null };
    persistBlockState();
    console.log('[SG] LOCK_NOW', platform);
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

  // v2→v3 userConfig migration: the time-limit model became the earn-to-scroll
  // model. Map the old keys onto the new ones and drop the retired cooldown.
  if (userConfig && typeof userConfig === 'object' &&
      ('limitMs' in userConfig || 'passwordGraceMs' in userConfig || 'blockCooldownMs' in userConfig)) {
    if ('limitMs' in userConfig && userConfig.dailyCeilingMs == null) userConfig.dailyCeilingMs = userConfig.limitMs;
    if ('passwordGraceMs' in userConfig && userConfig.passwordGrantMs == null) userConfig.passwordGrantMs = userConfig.passwordGraceMs;
    delete userConfig.limitMs;
    delete userConfig.passwordGraceMs;
    delete userConfig.blockCooldownMs;
    await SGStorage.set('userConfig', userConfig);
    console.log('[SG] migrated userConfig v2→v3 (limitMs→dailyCeilingMs, passwordGraceMs→passwordGrantMs)');
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
