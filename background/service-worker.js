'use strict';
importScripts('/lib/config.js', '/lib/engine.js', '/lib/storage.js');
const C = SG, E = SGEngine;
let state;
let tabs = new Map(), focusedWindow = null, idle = 'active', active = null;
let access = new Set(), visible = new Map(), lastPulse = new Map(), returnUrls = new Map();
let expiryTimer = null, appliedRevision = -1;
let initialized = false;

// Every event and UI mutation shares this queue. No concurrent read/modify/write grants.
const reportError = error => console.error('[ScrollGuard]', error);
let queue = initialize().catch(reportError);
function enqueue(work) {
  const result = queue.then(async () => {
    // A temporary startup API failure must not leave an unusable worker alive.
    if (!initialized) await initialize();
    return work();
  });
  queue = result.catch(reportError);
  return result;
}
const siteFor = url => state.sites.find(s => C.matches(s, url));
const trustedPage = sender => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));

async function initialize() {
  // Install recovery before touching storage or registering content scripts.
  await chrome.alarms.create('maintenance', { periodInMinutes: .5 });
  // Challenges and configuration are private to trusted extension contexts.
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  state = await SGStorage.load(Date.now());
  E.rollover(state, Date.now());
  await configure();
  await scanBrowser();
  await enforce(Date.now());
  await commit();
  initialized = true;
}
async function scanBrowser() {
  tabs = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
  for (const id of visible.keys()) if (!tabs.has(id)) visible.delete(id);
  for (const id of lastPulse.keys()) if (!tabs.has(id)) lastPulse.delete(id);
  const win = await chrome.windows.getLastFocused().catch(() => null);
  focusedWindow = win?.focused ? win.id : null;
  idle = await chrome.idle.queryState(state.settings.idleSeconds);
  pickActive(Date.now());
}
function pickActive(now) {
  const tab = [...tabs.values()].find(t => t.active && t.windowId === focusedWindow && !t.discarded);
  const site = tab && siteFor(tab.url);
  const eligible = site && site.mode !== 'off' && access.has(site.domain) && visible.get(tab.id) !== false
    && idle !== 'locked' && !(state.settings.pauseIdle && idle === 'idle');
  active = eligible ? { tabId: tab.id, domain: site.domain, at: now } : null;
}
function settle(now) {
  if (active) {
    const elapsed = now - active.at;
    // A missing heartbeat means sleep, suspension, or a stalled page, not proven active use.
    if (elapsed > 0 && elapsed <= 5000) E.charge(state, active.domain, active.at, now);
    active.at = now;
  }
  E.rollover(state, now);
}
async function configure() {
  // Keep failed permission/registration refreshes eligible for the next retry.
  appliedRevision = -1;
  chrome.idle.setDetectionInterval(state.settings.idleSeconds);
  access = new Set();
  const desired = [];
  for (const site of state.sites) {
    if (await chrome.permissions.contains({ origins: C.origins(site) })) {
      access.add(site.domain);
      if (site.mode !== 'off') desired.push({ id: `sg-${site.domain}`, matches: C.origins(site),
        js: ['content/detector.js'], runAt: 'document_start', persistAcrossSessions: true });
    }
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const owned = registered.filter(s => s.id.startsWith('sg-'));
  const same = (a, b) => a.id === b.id && JSON.stringify(a.matches) === JSON.stringify(b.matches);
  const remove = owned.filter(s => !desired.some(d => same(s, d))).map(s => s.id);
  const add = desired.filter(s => !owned.some(d => same(s, d)));
  if (remove.length) await chrome.scripting.unregisterContentScripts({ ids: remove });
  if (add.length) await chrome.scripting.registerContentScripts(add);
  // Registration covers future documents; seed already-open tabs too.
  for (const tab of await chrome.tabs.query({})) {
    const site = siteFor(tab.url);
    if (site && site.mode !== 'off' && access.has(site.domain)) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/detector.js'] }).catch(() => {});
    }
  }
  appliedRevision = state.revision;
}
async function repairHeartbeat(now) {
  const tab = [...tabs.values()].find(t => t.active && t.windowId === focusedWindow && !t.discarded);
  const site = tab && siteFor(tab.url);
  if (!site || site.mode === 'off' || !access.has(site.domain)) return;
  const last = lastPulse.get(tab.id);
  if (last != null && now >= last && now - last <= 5000) return;
  // A lost content heartbeat must not turn a daily allowance into unlimited use.
  // Visibility may itself be stale, so repair the selected tab regardless of its
  // last visibility message. Failed injections are retried next maintenance.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/detector.js'] }).catch(() => {});
}
async function enforce(now) {
  const close = [];
  for (const tab of tabs.values()) {
    const site = siteFor(tab.pendingUrl || tab.url);
    if (!site || E.status(state, site, now) !== 'blocked') continue;
    if (C.matches(site, tab.url)) returnUrls.set(site.domain, tab.url);
    close.push({ id: tab.id, site });
  }
  const closedSites = new Map();
  for (const { id, site } of close) {
    try { await chrome.tabs.remove(id); }
    catch { continue; }
    closedSites.set(site.domain, site);
    tabs.delete(id);
    visible.delete(id);
    lastPulse.delete(id);
    if (active?.tabId === id) active = null;
  }
  // One notification per website in this closure batch, after at least one tab
  // was actually closed. Later blocked visits should notify again.
  if (state.settings.notifications) {
    for (const site of closedSites.values()) {
      await chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-192.png'),
        title: 'ScrollGuard', message: `You've reached your time limit for ${site.name}`,
      }).catch(error => console.error('[ScrollGuard] Notification failed:', error.message));
    }
  }
}
async function schedule() {
  clearTimeout(expiryTimer);
  const now = Date.now();
  let deadline = E.nextReset(now);
  for (const site of state.sites) {
    const until = E.usage(state, site.domain).breakUntil;
    if (until > now) deadline = Math.min(deadline, until);
  }
  await chrome.alarms.create('deadline', { when: deadline });
  // The alarm survives worker sleep. While awake this closes a break promptly.
  if (deadline - now < 2 ** 31 - 1) expiryTimer = setTimeout(() => enqueue(maintenance), Math.max(0, deadline - now));
}
async function commit() {
  for (const site of state.sites) E.usage(state, site.domain);
  await SGStorage.save(state);
  if (appliedRevision !== state.revision) await configure();
  await schedule();
  const tab = [...tabs.values()].find(t => t.active && t.windowId === focusedWindow);
  const site = tab && siteFor(tab.url);
  let label = '';
  if (site && state.settings.badge) {
    const kind = E.status(state, site, Date.now());
    const u = E.usage(state, site.domain);
    label = kind === 'blocked' ? 'STOP' : kind === 'break' ? 'BREAK' : kind === 'available'
      ? String(Math.ceil(Math.max(0, site.limitMinutes * C.MINUTE - u.baseMs) / C.MINUTE)) : '';
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#6558d9' });
  await chrome.action.setBadgeText({ text: label });
}
async function maintenance() {
  const now = Date.now();
  settle(now);
  // Refresh live tabs after sleep/restart; never reuse old browser focus as evidence of usage.
  await scanBrowser();
  await enforce(now);
  await repairHeartbeat(now);
  await commit();
}
function overview(now) {
  return { day: state.day, resetAt: E.nextReset(now), settings: state.settings,
    pending: state.pending && { settings: state.pending.settings, sites: state.pending.sites },
    notice: state.notice, history: state.history,
    sites: state.sites.map(site => ({ ...site, usage: E.usage(state, site.domain),
      status: E.status(state, site, now), terms: E.terms(state, site, now), access: access.has(site.domain) })) };
}
function createChallenge(site, purpose = 'break', proposal = null) {
  const now = Date.now();
  const key = purpose === 'settings' ? '$settings' : site.domain;
  const existing = state.challenges[key];
  if (purpose === 'break' && existing && !existing.done && existing.day === state.day && existing.revision === state.revision) return existing;
  const t = purpose === 'settings'
    ? { questions: state.settings.questions, difficulty: state.settings.difficulty, rewardMs: 0 }
    : E.terms(state, site, now);
  if (t.reason) throw new Error(t.reason);
  const ch = { id: crypto.randomUUID(), site: site?.domain || null, purpose, day: state.day,
    revision: state.revision, questions: t.questions, difficulty: t.difficulty, rewardMs: t.rewardMs,
    completed: 0, problems: Array.from({ length: t.questions }, () => E.problem(t.difficulty)), proposal };
  state.challenges[key] = ch;
  return ch;
}
async function openChallenge(ch) {
  const url = chrome.runtime.getURL(`challenge/challenge.html?id=${encodeURIComponent(ch.id)}`);
  const existing = (await chrome.tabs.query({})).find(t => t.url === url);
  if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}
function applyProposal(proposal) {
  state.settings = proposal.settings;
  state.sites = proposal.sites;
  state.pending = null;
  state.challenges = {};
  state.revision++;
}
async function changeConfig(proposal) {
  // Protection covers all edits to existing rules, so no relaxation slips through a comparison.
  // Adding the first rules is always available; there is no current restriction to bypass.
  const protection = state.sites.length ? state.settings.protection : 'immediate';
  if (protection === 'next-reset') {
    state.pending = structuredClone(proposal);
    await commit();
    return { message: 'Saved for the next 6 AM reset.' };
  }
  if (protection === 'challenge') {
    const ch = createChallenge(null, 'settings', proposal);
    await commit();
    await openChallenge(ch);
    return { message: 'Complete the math challenge to apply these changes.' };
  }
  applyProposal(proposal);
  await configure();
  pickActive(Date.now());
  await enforce(Date.now());
  await commit();
  return { message: 'Saved.' };
}
async function dispatch(msg, sender) {
  const now = Date.now();
  settle(now);
  if (msg.type === 'PULSE') {
    if (sender.frameId !== 0 || !sender.tab) return {};
    const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
    if (!tab || !siteFor(tab.url) || !C.matches(siteFor(tab.url), sender.url)) return { tracking: false };
    tabs.set(tab.id, tab);
    visible.set(tab.id, msg.visible === true);
    lastPulse.set(tab.id, now);
    pickActive(now);
    await enforce(now);
    await commit();
    return { tracking: siteFor(tab.url)?.mode !== 'off' };
  }
  if (!trustedPage(sender)) throw new Error('This action is available only inside ScrollGuard.');
  if (msg.type === 'GET_STATE') {
    await enforce(now);
    await commit();
    return overview(now);
  }
  if (msg.type === 'SAVE_SETTINGS') {
    const proposal = state.pending || { settings: state.settings, sites: state.sites };
    return changeConfig({ sites: proposal.sites, settings: C.settings(msg.settings) });
  }
  if (msg.type === 'SAVE_SITE') {
    const proposal = state.pending || { settings: state.settings, sites: state.sites };
    const site = C.site(msg.site, proposal.sites);
    if (!await chrome.permissions.contains({ origins: C.origins(site) })) throw new Error('Allow website access to enable tracking.');
    const existing = proposal.sites.findIndex(s => s.domain === site.domain);
    if (existing !== -1 && !msg.editing) throw new Error('This website is already added. Edit its existing rule.');
    const sites = proposal.sites.slice();
    if (existing < 0) sites.push(site); else sites[existing] = site;
    if (!state.sites.some(s => s.domain === site.domain) && existing < 0) {
      // Adding a rule cannot weaken any existing rule. Do not apply other queued changes early.
      state.sites.push(site);
      if (state.pending) state.pending.sites.push(site);
      state.revision++;
      await configure();
      pickActive(now);
      await enforce(now);
      await commit();
      return { message: 'Website added.' };
    }
    return changeConfig({ settings: proposal.settings, sites });
  }
  if (msg.type === 'REMOVE_SITE') {
    const proposal = state.pending || { settings: state.settings, sites: state.sites };
    return changeConfig({ settings: proposal.settings, sites: proposal.sites.filter(s => s.domain !== msg.domain) });
  }
  if (msg.type === 'CANCEL_PENDING') { state.pending = null; await commit(); return {}; }
  if (msg.type === 'DISMISS_NOTICE') { state.notice = null; await commit(); return {}; }
  if (msg.type === 'REFRESH_ACCESS') { await configure(); pickActive(now); await commit(); return {}; }
  if (msg.type === 'START_CHALLENGE') {
    const site = state.sites.find(s => s.domain === msg.domain);
    if (!site) throw new Error('This website was removed.');
    if (!access.has(site.domain)) throw new Error('Restore website access before earning a break.');
    const ch = createChallenge(site);
    await commit();
    await openChallenge(ch);
    return {};
  }
  if (msg.type === 'GET_CHALLENGE' || msg.type === 'ANSWER') {
    const ch = Object.values(state.challenges).find(c => c.id === msg.id);
    if (!ch || ch.day !== state.day || ch.revision !== state.revision) throw new Error('This challenge is no longer current. Return to ScrollGuard to start again.');
    const site = state.sites.find(s => s.domain === ch.site);
    if (msg.type === 'GET_CHALLENGE') return { challenge: E.publicChallenge(ch), name: site?.name || 'Settings', proposal: ch.proposal };
    if (ch.done) return { challenge: E.publicChallenge(ch), correct: true };
    const result = E.answer(ch, msg.answer, msg.index);
    if (result.complete) {
      if (ch.purpose === 'settings') {
        const publicResult = { ...E.publicChallenge(ch), done: true };
        applyProposal(ch.proposal);
        await configure();
        pickActive(now);
        await enforce(now);
        await commit();
        return { challenge: publicResult, correct: true };
      }
      if (!site) throw new Error('This website was removed.');
      E.grant(state, site, ch, now);
      await commit(); // Persist reward and completion before opening any website.
      if (C.effective(state, site).autoReopen) {
        const url = returnUrls.get(site.domain);
        await chrome.tabs.create({ url: url && C.matches(site, url) ? url : `https://${site.domain}/` }).catch(() => {});
      }
    } else await commit();
    return { ...result, challenge: E.publicChallenge(ch) };
  }
  if (msg.type === 'OPEN_SITE') {
    const site = state.sites.find(s => s.domain === msg.domain);
    if (!site || E.status(state, site, now) === 'blocked') throw new Error('This website is blocked. Earn a break first.');
    await chrome.tabs.create({ url: `https://${site.domain}/` });
    return {};
  }
  throw new Error('Unknown action.');
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return;
  enqueue(async () => {
    // Roll back in-memory mutations if validation or persistence fails.
    const before = structuredClone(state);
    try { return await dispatch(msg, sender); }
    catch (error) { state = before; throw error; }
  }).then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
  return true;
});
function browserEvent(update) {
  enqueue(async () => { const now = Date.now(); settle(now); await update(); pickActive(now); await enforce(now); await commit(); });
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => browserEvent(async () => {
  for (const tab of tabs.values()) if (tab.windowId === windowId) tab.active = tab.id === tabId;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) tabs.set(tabId, tab);
}));
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status || 'discarded' in change) browserEvent(() => {
    tabs.set(id, tab);
    if (change.url) { visible.delete(id); lastPulse.delete(id); }
  });
});
chrome.tabs.onCreated.addListener(tab => browserEvent(() => tabs.set(tab.id, tab)));
chrome.tabs.onRemoved.addListener(id => browserEvent(() => { tabs.delete(id); visible.delete(id); lastPulse.delete(id); }));
chrome.tabs.onAttached.addListener(() => browserEvent(scanBrowser));
chrome.tabs.onDetached.addListener(() => browserEvent(scanBrowser));
chrome.tabs.onReplaced.addListener(() => browserEvent(scanBrowser));
chrome.windows.onFocusChanged.addListener(id => browserEvent(() => { focusedWindow = id === chrome.windows.WINDOW_ID_NONE ? null : id; }));
chrome.idle.onStateChanged.addListener(value => browserEvent(() => { idle = value; }));
chrome.alarms.onAlarm.addListener(alarm => { if (['maintenance', 'deadline'].includes(alarm.name)) enqueue(maintenance); });
chrome.permissions.onAdded.addListener(() => browserEvent(configure));
chrome.permissions.onRemoved.addListener(() => browserEvent(configure));
chrome.runtime.onStartup.addListener(() => enqueue(maintenance));
