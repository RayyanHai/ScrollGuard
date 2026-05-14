// ScrollGuard service worker.
//
// Pipeline at a glance:
//   nav events → session/segment tracking → 1s tick → per-group active-time
//   accumulator → limit check → block state → content-script BLOCK/UNLOCK msg
//
// State buckets, with where each lives:
//   tabSessions       in-memory (mirrored to storage as 'currentSessions')
//   tabState          in-memory only (cheap to rebuild from chrome APIs)
//   bucketActiveMs    storage 'bucketActiveMs' (read on SW start, written each tick)
//   blockState        storage 'blockState'      (read on SW start, written on change)
//
// Why bucketActiveMs is its own number instead of derived from segments:
// it's the limit-decision counter. We RESET it when a block triggers, so
// after a block expires the user starts at zero again. Recomputing from
// segments doesn't have a clean reset semantics. Segments stay untouched
// for the dashboard.

importScripts('/lib/classifier.js', '/lib/storage.js', '/lib/config.js');

const STRICT_CONTEXTS = new Set(['reels', 'stories']);

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<number, Session>} tabId → in-flight session */
const tabSessions = new Map();
/** @type {Map<number, {windowId:number, isActiveInWindow:boolean, isVisible:boolean}>} */
const tabState = new Map();
let focusedWindowId = null;

let lastTickAt = Date.now();
let ticksSincePersist = 0;
let pendingPersist = false;

// Per-group active-time accumulator. Reset on block trigger.
// { scroll: ms, reels: ms, other: ms }
let bucketActiveMs = {};

// Per-group block state.
// { scroll: { blockedUntil: ts, unlockUntil: ts|null }, ... }
let blockState = {};

// Per-tab last-sent overlay state, so we don't spam BLOCK messages every tick.
// 'hidden' | 'blocked' | 'unlocked'
const lastOverlayState = new Map();

// User-edited config from chrome.storage.local 'userConfig'. Layered ON TOP
// of the hardcoded SG_CONFIG defaults — anything missing falls through.
// The popup writes this; we listen to chrome.storage.onChanged below.
let userConfig = {};

function cfg() {
  return {
    limits: { ...self.SG_CONFIG.limits, ...(userConfig.limits || {}) },
    contextToGroup: self.SG_CONFIG.contextToGroup,
    blockCooldownMs: userConfig.blockCooldownMs ?? self.SG_CONFIG.blockCooldownMs,
    passwordGraceMs: userConfig.passwordGraceMs ?? self.SG_CONFIG.passwordGraceMs,
    password: userConfig.password ?? self.SG_CONFIG.password,
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.userConfig) {
    userConfig = changes.userConfig.newValue ?? {};
    console.log('[SG] userConfig updated');
  }
});

// ---------------------------------------------------------------------------
// Session/segment helpers
// ---------------------------------------------------------------------------

function newSession(tabId, ts) {
  return { id: crypto.randomUUID(), tabId, startedAt: ts, endedAt: null, segments: [], classification: null };
}
function classifySession(s) {
  const total = s.endedAt - s.startedAt;
  if (total < 60_000) return 'quick_check';
  if (total < 5 * 60_000) return 'browsing';
  return 'deep_scroll';
}
function startSegment(s, ctx, ts) {
  s.segments.push({ context: ctx, startedAt: ts, endedAt: null, activeMs: 0, passiveMs: 0 });
}
function closeOpenSegment(s, ts) {
  const last = s.segments[s.segments.length - 1];
  if (last && last.endedAt === null) last.endedAt = ts;
}

async function persistCurrent() {
  const obj = {};
  for (const [tid, s] of tabSessions) obj[tid] = s;
  await SGStorage.set('currentSessions', obj);
  await SGStorage.set('bucketActiveMs', bucketActiveMs);
  pendingPersist = false;
  ticksSincePersist = 0;
}

async function persistBlockState() {
  await SGStorage.set('blockState', blockState);
}

async function endSession(tabId, reason) {
  const session = tabSessions.get(tabId);
  if (!session) return;
  const now = Date.now();
  closeOpenSegment(session, now);
  session.endedAt = now;
  session.classification = classifySession(session);
  console.log('[SG] session ended:', reason, '|', session.classification, '|', session.segments.length, 'seg');
  const key = SGStorage.dateKey(session.startedAt);
  await SGStorage.update(key, [], (arr) => { arr.push(session); return arr; });
  tabSessions.delete(tabId);
  tabState.delete(tabId);
  lastOverlayState.delete(tabId);
  await persistCurrent();
}

async function onIGNavigation(tabId, ctx, url) {
  const now = Date.now();
  let session = tabSessions.get(tabId);
  if (!session) {
    session = newSession(tabId, now);
    tabSessions.set(tabId, session);
    startSegment(session, ctx, now);
    console.log('[SG] session started: tab', tabId, '| ctx', ctx);
  } else {
    const last = session.segments[session.segments.length - 1];
    if (!last || last.context !== ctx) {
      closeOpenSegment(session, now);
      startSegment(session, ctx, now);
      console.log('[SG] segment: tab', tabId, '|', last?.context ?? '(none)', '→', ctx);
    }
  }
  pendingPersist = true;
  // Don't send CONTEXT_CHANGE — the content script doesn't need it for the
  // intervention, and the next tick will send the right BLOCK/UNLOCK/CLEAR.
}

// ---------------------------------------------------------------------------
// Navigation listeners
// ---------------------------------------------------------------------------

function isIGUrl(url) {
  if (!url) return false;
  try { const h = new URL(url).hostname; return h === 'instagram.com' || h.endsWith('.instagram.com'); }
  catch { return false; }
}

const navFilter = { url: [{ hostSuffix: 'instagram.com' }] };
async function handleNav(details) {
  if (details.frameId !== 0) return;
  const ctx = self.classifyContext(details.url);
  const st = tabState.get(details.tabId) ?? { isActiveInWindow: false, isVisible: false };
  try {
    const tab = await chrome.tabs.get(details.tabId);
    st.windowId = tab.windowId;
    st.isActiveInWindow = tab.active;
  } catch {}
  tabState.set(details.tabId, st);
  await onIGNavigation(details.tabId, ctx, details.url);

  // Send overlay state immediately on every nav (including reloads), not on
  // the next 1s tick. Closes the visible-IG gap when reloading a blocked
  // page. The .catch swallows the case where the content script isn't ready
  // yet — its own REQUEST_BLOCK_STATE on load is the backup path.
  const target = evaluateOverlayFor(ctx, Date.now());
  sendOverlay(details.tabId, target);
  lastOverlayState.set(details.tabId, target.mode);
}
chrome.webNavigation.onCommitted.addListener(handleNav, navFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNav, navFilter);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  if (!tabSessions.has(tabId)) return;
  if (!isIGUrl(tab.url)) await endSession(tabId, 'navigated-away');
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabSessions.has(tabId)) await endSession(tabId, 'tab-closed');
  tabState.delete(tabId);
  lastOverlayState.delete(tabId);
});

// ---------------------------------------------------------------------------
// Focus / visibility
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
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

function groupForContext(ctx) {
  return cfg().contextToGroup[ctx]; // undefined for dm and unknown
}

function isSegmentActive(tabId, ctx) {
  const st = tabState.get(tabId);
  if (!st) return false;
  if (!STRICT_CONTEXTS.has(ctx)) return true;
  return st.isActiveInWindow && st.isVisible && st.windowId === focusedWindowId;
}

// Returns the overlay state we should be sending to a tab right now.
// 'blocked' = show overlay, 'unlocked' = hide overlay (in grace period),
// 'hidden' = hide overlay (no block at all).
function evaluateOverlayFor(ctx, now) {
  const group = groupForContext(ctx);
  if (!group) return { mode: 'hidden' };
  const bs = blockState[group];
  if (!bs || bs.blockedUntil <= now) return { mode: 'hidden' };
  if (bs.unlockUntil && bs.unlockUntil > now) {
    return { mode: 'unlocked', group, blockedUntil: bs.blockedUntil, unlockUntil: bs.unlockUntil };
  }
  return { mode: 'blocked', group, blockedUntil: bs.blockedUntil };
}

function sendOverlay(tabId, evalResult) {
  // Tell the content script whether a password is configured. When false,
  // the overlay swaps the unlock input for a "set up in the popup" message.
  const passwordSet = !!cfg().password;
  if (evalResult.mode === 'blocked') {
    chrome.tabs.sendMessage(tabId, { type: 'BLOCK', group: evalResult.group, blockedUntil: evalResult.blockedUntil, passwordSet }).catch(() => {});
  } else if (evalResult.mode === 'unlocked') {
    chrome.tabs.sendMessage(tabId, { type: 'UNLOCK', group: evalResult.group, unlockUntil: evalResult.unlockUntil }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The 1-second tick
// ---------------------------------------------------------------------------

async function tick() {
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;
  const cappedElapsed = elapsed > 2000 ? 0 : elapsed;

  let blockChanged = false;

  for (const [tabId, session] of tabSessions) {
    const seg = session.segments[session.segments.length - 1];
    if (!seg || seg.endedAt !== null) continue;
    const active = isSegmentActive(tabId, seg.context);

    // 1) Accumulate per-segment active/passive (for the dashboard).
    if (cappedElapsed > 0) {
      if (active) seg.activeMs += cappedElapsed;
      else seg.passiveMs += cappedElapsed;
      pendingPersist = true;
    }

    // 2) Accumulate per-group bucket (for block decisions). Only counts
    // active engagement — passive (background tab, minimized) does not
    // tick toward your limit, by design.
    const group = groupForContext(seg.context);
    if (group && active && cappedElapsed > 0) {
      bucketActiveMs[group] = (bucketActiveMs[group] ?? 0) + cappedElapsed;

      // 3) Check if this group just hit its limit and we're not already
      // in an active block for it.
      const c = cfg();
      const limit = c.limits[group];
      const bs = blockState[group];
      const alreadyBlocked = bs && bs.blockedUntil > now;
      if (limit && bucketActiveMs[group] >= limit && !alreadyBlocked) {
        blockState[group] = {
          blockedUntil: now + c.blockCooldownMs,
          unlockUntil: null,
        };
        // Reset the bucket so when the block expires the user starts fresh.
        bucketActiveMs[group] = 0;
        blockChanged = true;
        console.log('[SG] LIMIT HIT for group', group, '— blocked until', new Date(blockState[group].blockedUntil).toLocaleTimeString());
      }
    }

    // 4) Decide what overlay state this tab should be in and send it
    //    (only if it changed, to avoid message spam).
    const target = evaluateOverlayFor(seg.context, now);
    const last = lastOverlayState.get(tabId);
    if (last !== target.mode || blockChanged) {
      sendOverlay(tabId, target);
      lastOverlayState.set(tabId, target.mode);
    }
  }

  // 5) Auto-expire blocks. We don't need to do anything special — the
  //    evaluateOverlayFor check on next tick will see blockedUntil <= now
  //    and flip to 'hidden'. But we clean up the storage entry to keep it tidy.
  for (const group of Object.keys(blockState)) {
    if (blockState[group].blockedUntil <= now) {
      delete blockState[group];
      blockChanged = true;
      console.log('[SG] block expired for group', group);
    }
  }

  if (blockChanged) await persistBlockState();

  ticksSincePersist++;
  if (pendingPersist && ticksSincePersist >= 5) await persistCurrent();
}
setInterval(tick, 1000);

// ---------------------------------------------------------------------------
// Messages from content scripts
// ---------------------------------------------------------------------------

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
    // Verify in the SW so the page can't bypass by inspecting/altering JS.
    // We send back ok:true/false; on success we set unlockUntil and the
    // next tick will send UNLOCK to the content script.
    const c = cfg();
    // If no password is configured, reject every attempt — the user must
    // complete the popup's first-time setup before unlock is possible.
    const ok = !!c.password && msg.password === c.password;
    if (ok && tabId != null) {
      const session = tabSessions.get(tabId);
      const ctx = session?.segments?.slice(-1)?.[0]?.context;
      const group = ctx ? groupForContext(ctx) : null;
      if (group && blockState[group]) {
        blockState[group].unlockUntil = Date.now() + c.passwordGraceMs;
        persistBlockState();
        console.log('[SG] unlocked', group, 'for', c.passwordGraceMs / 1000, 's');
      }
    } else if (!ok) {
      console.log('[SG] wrong password attempted');
    }
    sendResponse({ ok });
    return true; // keep channel open for async sendResponse
  }

  if (msg?.type === 'LOCK_NOW') {
    // Proactive self-lock: blocks every group for the cooldown duration.
    // No password gate to enable — friction is on the way out, not in.
    const c = cfg();
    const now = Date.now();
    for (const group of Object.keys(c.limits)) {
      blockState[group] = { blockedUntil: now + c.blockCooldownMs, unlockUntil: null };
      bucketActiveMs[group] = 0;
    }
    persistBlockState();
    persistCurrent();
    console.log('[SG] LOCK_NOW: all groups blocked');
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'RESET_TODAY') {
    // Wipe today's accumulated buckets and clear all blocks. Useful for
    // a fresh start, or after fiddling with limits during testing.
    bucketActiveMs = {};
    blockState = {};
    persistBlockState();
    persistCurrent();
    console.log('[SG] RESET_TODAY: buckets and blocks cleared');
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'REQUEST_BLOCK_STATE') {
    if (tabId == null) return;
    // Try session first (correct context), fall back to URL classification
    // for the moment between page load and first SW nav handling.
    let ctx;
    const session = tabSessions.get(tabId);
    ctx = session?.segments?.slice(-1)?.[0]?.context;
    if (!ctx && sender.tab?.url) ctx = self.classifyContext(sender.tab.url);
    if (ctx) sendOverlay(tabId, evaluateOverlayFor(ctx, Date.now()));
    return;
  }
});

// ---------------------------------------------------------------------------
// SW restart recovery
// ---------------------------------------------------------------------------

(async () => {
  try {
    const win = await chrome.windows.getLastFocused();
    focusedWindowId = win.focused ? win.id : null;
    console.log('[SG] seeded focusedWindowId =', focusedWindowId);
  } catch {}

  bucketActiveMs = await SGStorage.get('bucketActiveMs', {});
  blockState = await SGStorage.get('blockState', {});
  userConfig = await SGStorage.get('userConfig', {});

  const saved = await SGStorage.get('currentSessions', {});
  for (const [tid, s] of Object.entries(saved)) tabSessions.set(Number(tid), s);
  if (tabSessions.size) {
    console.log('[SG] restored', tabSessions.size, 'in-flight session(s)');
    for (const tabId of tabSessions.keys()) {
      try {
        const tab = await chrome.tabs.get(tabId);
        tabState.set(tabId, { windowId: tab.windowId, isActiveInWindow: tab.active, isVisible: false });
      } catch { await endSession(tabId, 'tab-gone-on-restart'); }
    }
  }
})();

console.log('[SG] service worker started');
