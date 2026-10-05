const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/config.js');
const E = require('../lib/engine.js');
const { harness } = require('./worker-harness.js');
const now = new Date('2026-09-16T12:00:00').getTime();
function stateWith(limitMinutes = 5) {
  const state = E.fresh(now);
  state.sites = [C.site({ domain: 'example.com', limitMinutes })];
  return state;
}
async function solve(h, id) {
  for (;;) {
    const ch = Object.values(h.read().challenges).find(c => c.id === id);
    if (!ch || ch.done) return;
    const response = await h.send({ type: 'ANSWER', id, index: ch.completed, answer: String(ch.problems[ch.completed].answer) });
    assert.equal(response.ok, true, response.error);
    if (response.challenge.done) return;
  }
}
test('daily exhaustion closes all matching tabs but leaves unrelated tabs alone', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(.05) }, tabs: [
    { id: 1, url: 'https://example.com', active: true }, { id: 2, url: 'https://m.example.com/a', active: false }, { id: 3, url: 'https://other.test', active: false },
  ] });
  for (let i = 0; i < 3; i++) { h.advance(1000); await h.pulse(1); }
  assert.deepEqual(h.removed.sort(), [1, 2]);
  assert.ok(h.currentTabs.has(3));
  assert.equal(h.read().usage['example.com'].baseMs, 3000);
  h.currentTabs.set(4, { id: 4, windowId: 1, active: false, url: 'https://example.com/again' });
  h.chrome.tabs.onCreated.emit(h.currentTabs.get(4)); await h.flush();
  assert.ok(h.removed.includes(4));
});
test('focus changes stop daily usage and long sleep gaps are not charged', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith() }, tabs: [{ id: 1, url: 'https://example.com' }] });
  h.advance(1000); await h.pulse(1);
  await h.focus(null); h.advance(10_000); await h.pulse(1);
  assert.equal(h.read().usage['example.com'].baseMs, 1000);
  await h.focus(1); h.advance(60 * 60_000); await h.pulse(1);
  assert.equal(h.read().usage['example.com'].baseMs, 1000);
  h.advance(1000); await h.pulse(1);
  assert.equal(h.read().usage['example.com'].baseMs, 2000);
});

test('Shorts accounting follows same-tab navigation and never closes ordinary YouTube pages', async () => {
  const state = E.fresh(now);
  state.sites = [C.site({ domain: 'youtube.com/shorts', limitMinutes: .05 })];
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [
    { id: 1, url: 'https://www.youtube.com/watch?v=regular', active: true },
    { id: 2, url: 'https://www.youtube.com/watch?v=other', active: false },
    { id: 3, url: 'https://m.youtube.com/shorts/another', active: false },
  ] });
  assert.ok(h.executions.some(e => e.target.tabId === 1), 'Existing non-Shorts pages need a detector for later navigation');
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    assert.equal((await h.pulse(1)).tracking, true, 'The detector must stay alive outside Shorts');
  }
  assert.equal(h.read().usage['youtube.com'].baseMs, 0);
  const navigate = url => h.navigate(1, url);
  await navigate('https://www.youtube.com/shorts/abc');
  h.advance(1000); await h.pulse(1);
  assert.equal(h.read().usage['youtube.com'].baseMs, 1000);
  await navigate('https://www.youtube.com/watch?v=regular');
  h.advance(1000); await h.pulse(1);
  assert.equal(h.read().usage['youtube.com'].baseMs, 1000);
  await navigate('https://www.youtube.com/shorts/def');
  for (let i = 0; i < 2; i++) { h.advance(1000); await h.pulse(1); }
  assert.deepEqual(h.removed, [3]);
  assert.equal(h.currentTabs.get(1).url, 'https://www.youtube.com/watch?v=regular');
  assert.ok(h.currentTabs.has(2), 'Regular YouTube video must remain open');
});

test('Shorts break links and automatic reopening use Shorts after a worker restart', async () => {
  const state = E.fresh(now);
  state.sites = [C.site({ domain: 'youtube.com', scope: 'shorts', limitMinutes: 0 })];
  state.settings.questions = 1;
  const h = await harness({ now, storage: { scrollguardV4: state } });
  await h.send({ type: 'START_CHALLENGE', domain: 'youtube.com' });
  await solve(h, h.read().challenges['youtube.com'].id);
  assert.equal(h.created.at(-1).url, 'https://youtube.com/shorts');
  const restarted = await harness({ now: now + 1000, storage: h.storage });
  assert.equal((await restarted.send({ type: 'OPEN_SITE', domain: 'youtube.com' })).ok, true);
  assert.equal(restarted.created.at(-1).url, 'https://youtube.com/shorts');
});
test('concurrent final answers grant once, and break expiry blocks after restart', async () => {
  const state = stateWith(0); state.settings.questions = 1;
  const h = await harness({ now, storage: { scrollguardV4: state } });
  assert.equal((await h.send({ type: 'START_CHALLENGE', domain: 'example.com' })).ok, true);
  const ch = h.read().challenges['example.com'];
  const messages = await Promise.all(Array.from({ length: 3 }, () => h.send({ type: 'ANSWER', id: ch.id, index: 0, answer: String(ch.problems[0].answer) })));
  assert.ok(messages.every(m => m.ok));
  assert.equal(h.read().usage['example.com'].breaks, 1);
  assert.equal(h.created.filter(t => t.url === 'https://example.com/').length, 1);
  const restored = await harness({ now: now + 30_000, storage: h.storage, tabs: [{ id: 10, url: 'https://example.com' }] });
  assert.equal(restored.removed.length, 0);
  restored.advance(30_001); restored.chrome.alarms.onAlarm.emit({ name: 'deadline' }); await restored.flush();
  assert.ok(restored.removed.includes(10));
});
test('wrong answers survive closing and reopening a challenge with progress intact', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) } });
  await h.send({ type: 'START_CHALLENGE', domain: 'example.com' });
  const ch = h.read().challenges['example.com'];
  await h.send({ type: 'ANSWER', id: ch.id, index: 0, answer: String(ch.problems[0].answer) });
  const wrong = await h.send({ type: 'ANSWER', id: ch.id, index: 1, answer: '99999' });
  assert.equal(wrong.correct, false); assert.equal(wrong.challenge.completed, 1);
  await h.send({ type: 'START_CHALLENGE', domain: 'example.com' });
  assert.equal(h.read().challenges['example.com'].id, ch.id);
  assert.equal(h.read().challenges['example.com'].completed, 1);
  assert.equal(h.read().usage['example.com'].breaks, 0);
});
test('content scripts cannot change settings or read challenge answers', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) } });
  const untrusted = { id: 'test-extension', url: 'https://example.com', tab: { id: 1 }, frameId: 0 };
  assert.equal((await h.send({ type: 'SAVE_SETTINGS', settings: { questions: 1 } }, untrusted)).ok, false);
  assert.equal((await h.send({ type: 'GET_STATE' }, untrusted)).ok, false);
  await h.send({ type: 'START_CHALLENGE', domain: 'example.com' });
  const ch = h.read().challenges['example.com'];
  const reply = await h.send({ type: 'GET_CHALLENGE', id: ch.id });
  assert.equal(reply.challenge.problems, undefined);
  assert.equal(reply.challenge.problem, ch.problems[0].text);
});
test('reset grants a new day and invalidates an unfinished challenge', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) } });
  await h.send({ type: 'START_CHALLENGE', domain: 'example.com' });
  const id = h.read().challenges['example.com'].id;
  h.setTime(new Date('2026-09-17T06:00:00').getTime());
  const reply = await h.send({ type: 'GET_CHALLENGE', id });
  assert.equal(reply.ok, false);
  await h.send({ type: 'GET_STATE' });
  assert.equal(h.read().day, '2026-09-17');
});
test('scheduled settings remain pending; adding a new site does not apply them early', async () => {
  const state = stateWith(); state.settings.protection = 'next-reset';
  const h = await harness({ now, storage: { scrollguardV4: state } });
  await h.send({ type: 'SAVE_SETTINGS', settings: { ...state.settings, questions: 10 } });
  await h.send({ type: 'SAVE_SITE', site: { domain: 'other.test', limitMinutes: 1 } });
  assert.equal(h.read().settings.questions, 5);
  assert.equal(h.read().pending.settings.questions, 10);
  assert.equal(h.read().sites.length, 2);
  h.setTime(new Date('2026-09-17T06:00:00').getTime());
  await h.send({ type: 'GET_STATE' });
  assert.equal(h.read().settings.questions, 10);
  assert.equal(h.read().sites.length, 2);
});
test('protected settings require math, award no break, and use old challenge requirements', async () => {
  const state = stateWith(); state.settings.protection = 'challenge'; state.settings.questions = 2;
  const h = await harness({ now, storage: { scrollguardV4: state } });
  await h.send({ type: 'SAVE_SETTINGS', settings: { ...state.settings, questions: 1, protection: 'immediate' } });
  const ch = h.read().challenges.$settings;
  assert.equal(ch.questions, 2);
  assert.equal(h.read().settings.protection, 'challenge');
  await solve(h, ch.id);
  assert.equal(h.read().settings.protection, 'immediate');
  assert.equal(h.read().usage['example.com'].breaks, 0);
});
test('migration retains old data and does not silently re-label midnight usage', async () => {
  const legacy = { userConfig: { dailyCeilingMs: 300_000, mathCount: 7, mathDifficulty: 3 }, dailyActive: { instagram: { date: '2026-09-16', ms: 250_000 } } };
  const h = await harness({ now, storage: legacy });
  assert.equal(h.read().sites[0].limitMinutes, 5);
  assert.equal(h.read().settings.questions, 7);
  assert.equal(h.read().settings.difficulty, 'hard');
  assert.equal(h.read().usage['instagram.com'].baseMs, 0);
  assert.deepEqual(h.storage.dailyActive, legacy.dailyActive);
  assert.match(h.read().notice, /6:00 AM/);
});

test('closure notifications use the nickname, follow tab closure, and group matching tabs', async () => {
  const state = stateWith(.05);
  state.sites[0].name = 'My videos';
  assert.equal(state.settings.notifications, true);
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [
    { id: 1, url: 'https://example.com', active: true },
    { id: 2, url: 'https://m.example.com/video', active: false },
  ] });
  assert.equal(h.notifications.length, 0);
  for (let i = 0; i < 3; i++) { h.advance(1000); await h.pulse(1); }
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, 'ScrollGuard');
  assert.equal(h.notifications[0].iconUrl, h.chrome.runtime.getURL('icons/icon-192.png'));
  assert.equal(h.notifications[0].message, "You've reached your time limit for My videos");
  assert.equal(h.notifications[0].silent, false);
  assert.deepEqual(h.notifications[0].closedTabIds, [1, 2]);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' }); await h.flush();
  assert.equal(h.notifications.length, 1);
  const retry = { id: 3, windowId: 1, active: true, url: 'https://example.com/again' };
  h.currentTabs.set(3, retry); h.chrome.tabs.onCreated.emit(retry); await h.flush();
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].message, "You've reached your time limit for My videos");
});

test('successful notifications also open one persistent overview alert for the whole closure batch', async () => {
  const state = stateWith(0);
  state.sites[0].name = 'My videos';
  state.sites.push(C.site({ domain: 'other.test', name: 'Other', limitMinutes: 0 }));
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [
    { id: 1, url: 'https://example.com' },
    { id: 2, url: 'https://m.example.com/watch', active: false },
    { id: 3, url: 'https://other.test', active: false },
  ] });
  assert.deepEqual(h.removed, [1, 2, 3]);
  assert.equal(h.notifications.length, 2);
  assert.equal(h.created.length, 1, 'A successful native API call does not prove the OS showed its banner');
  assert.equal(h.created[0].url, h.chrome.runtime.getURL('options/options.html#overview'));
  assert.equal(h.created[0].active, true);
  assert.deepEqual(h.focusedWindows, [1]);
  assert.equal((await h.send({ type: 'GET_STATE' })).limitNotice,
    "You've reached your time limit for My videos, Other. The website tabs were closed.");
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' }); await h.flush();
  assert.equal(h.notifications.length, 2);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.focusedWindows, [1], 'Maintenance without a new closure must not steal focus');
  const restored = await harness({ now, storage: h.storage });
  assert.match((await restored.send({ type: 'GET_STATE' })).limitNotice, /time limit for My videos, Other/);
  assert.equal(restored.notifications.length, 0);
  assert.equal(restored.created.length, 0, 'Restoring the saved explanation must not reopen it by itself');
});

test('each blocked revisit restores a dismissed alert and brings the existing overview forward', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) },
    tabs: [{ id: 1, url: 'https://example.com' }] });
  const hub = h.created[0];
  for (const id of [2, 3]) {
    assert.equal((await h.send({ type: 'DISMISS_LIMIT_NOTICE' })).ok, true);
    assert.equal((await h.send({ type: 'GET_STATE' })).limitNotice, null);
    await h.chrome.tabs.update(hub.id, {
      url: h.chrome.runtime.getURL('options/options.html#settings'), active: false,
    });
    const retry = { id, windowId: 1, active: true, url: `https://example.com/again-${id}` };
    h.currentTabs.set(id, retry);
    h.chrome.tabs.onCreated.emit(retry); await h.flush();
    assert.ok(h.removed.includes(id));
    assert.equal(h.notifications.length, id);
    assert.equal(h.created.length, 1, 'Revisits must reuse the existing hub');
    assert.equal(h.currentTabs.get(hub.id).url, h.chrome.runtime.getURL('options/options.html#overview'));
    assert.equal(h.currentTabs.get(hub.id).active, true);
    assert.match((await h.send({ type: 'GET_STATE' })).limitNotice, /time limit for example.com/);
    assert.equal(h.focusedWindows.length, id);
  }
});

for (const navigation of ['existing tab URL change', 'new tab pending URL']) {
  test(`blocked ${navigation} preserves prior pages and notifies`, async () => {
    const h = await harness({ now, storage: { scrollguardV4: stateWith(0) },
      tabs: navigation === 'existing tab URL change' ? [{ id: 1, url: 'https://unrelated.test' }] : [] });
    assert.equal(h.notifications.length, 0);
    if (navigation === 'existing tab URL change') {
      const tab = { id: 1, windowId: 1, active: true, url: 'https://example.com/again' };
      h.currentTabs.set(1, tab);
      h.chrome.tabs.onUpdated.emit(1, { url: tab.url }, tab);
    } else {
      const tab = { id: 1, windowId: 1, active: true, url: 'about:blank', pendingUrl: 'https://example.com/again' };
      h.currentTabs.set(1, tab);
      h.chrome.tabs.onCreated.emit(tab);
    }
    await h.flush();
    assert.equal(h.notifications.length, 1);
    if (navigation === 'existing tab URL change') {
      assert.deepEqual(h.removed, []);
      assert.equal(h.currentTabs.get(1).url, 'https://unrelated.test');
      assert.equal(h.created.length, 0);
      assert.deepEqual(h.focusedWindows, []);
    } else {
      assert.deepEqual(h.removed, [1]);
      assert.equal(h.created.length, 1);
      assert.equal(h.created[0].url, h.chrome.runtime.getURL('options/options.html#overview'));
    }
    assert.match((await h.send({ type: 'GET_STATE' })).limitNotice, /time limit for example.com/);
  });
}

test('clicking a closure notification reuses the opened home hub and dismisses the notification', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) },
    tabs: [{ id: 1, url: 'https://example.com' }] });
  assert.equal(h.notifications.length, 1);
  h.chrome.notifications.onClicked.emit('notification-1'); await h.flush();
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].url, h.chrome.runtime.getURL('options/options.html#overview'));
  assert.equal(h.created[0].active, true);
  assert.deepEqual(h.focusedWindows, [h.created[0].windowId, h.created[0].windowId]);
  assert.deepEqual(h.clearedNotifications, ['notification-1']);
  assert.equal(h.read().usage['example.com'].breaks, 0);
});

test('notification clicks after worker restart reuse the hub and return it to overview', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith(0) }, tabs: [
    { id: 5, windowId: 2, active: false, url: 'chrome-extension://test-extension/options/options.html#settings' },
  ] });
  // The notification can outlive its originating service worker.
  h.chrome.notifications.onClicked.emit('earlier-notification');
  h.chrome.notifications.onClicked.emit('another-notification');
  await h.flush();
  assert.equal(h.created.length, 0);
  assert.equal(h.currentTabs.get(5).url, h.chrome.runtime.getURL('options/options.html#overview'));
  assert.equal(h.currentTabs.get(5).active, true);
  assert.deepEqual(h.focusedWindows, [2, 2]);
  assert.deepEqual(h.clearedNotifications, ['earlier-notification', 'another-notification']);
});

test('an expired earned break notifies when the website closes', async () => {
  const state = stateWith(0);
  state.sites[0].name = 'TikTok';
  E.usage(state, 'example.com').breakUntil = now + 1000;
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [{ id: 1, url: 'https://example.com' }] });
  assert.equal(h.notifications.length, 0);
  h.advance(1001); h.chrome.alarms.onAlarm.emit({ name: 'deadline' }); await h.flush();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].message, "You've reached your time limit for TikTok");
});

test('manual closes and failed automatic closes do not produce limit notifications', async () => {
  const h = await harness({ now, storage: { scrollguardV4: stateWith() }, tabs: [{ id: 1, url: 'https://example.com' }] });
  h.currentTabs.delete(1); h.chrome.tabs.onRemoved.emit(1); await h.flush();
  assert.equal(h.notifications.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal((await h.send({ type: 'GET_STATE' })).limitNotice, null);
  const failure = await harness({ now, storage: { scrollguardV4: stateWith(0) },
    tabs: [{ id: 2, url: 'https://example.com' }], failRemoval: [2] });
  assert.equal(failure.notifications.length, 0);
  assert.equal(failure.created.length, 0);
  assert.equal((await failure.send({ type: 'GET_STATE' })).limitNotice, null);
  assert.ok(failure.currentTabs.has(2));
});

test('users can disable closure notifications without disabling tab closure', async () => {
  const state = stateWith(0); state.settings.notifications = false;
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [{ id: 1, url: 'https://example.com' }] });
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal((await h.send({ type: 'GET_STATE' })).limitNotice, null);
});

for (const failure of [{ notificationPermission: 'denied' }, { failNotifications: true }]) {
  test(`notification failure opens one overview with a persistent explanation: ${JSON.stringify(failure)}`, async () => {
    const state = stateWith(0);
    state.sites.push(C.site({ domain: 'other.test', name: 'Other', limitMinutes: 0 }));
    const h = await harness({ now, storage: { scrollguardV4: state }, ...failure, tabs: [
      { id: 1, url: 'https://example.com' }, { id: 2, url: 'https://other.test', active: false },
    ] });
    assert.deepEqual(h.removed, [1, 2]);
    assert.equal(h.notifications.length, 0);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].url, h.chrome.runtime.getURL('options/options.html#overview'));
    assert.deepEqual(h.focusedWindows, [1]);
    const restored = await harness({ now, storage: h.storage });
    assert.match((await restored.send({ type: 'GET_STATE' })).limitNotice, /time limit for example.com, Other/);
    await restored.send({ type: 'DISMISS_LIMIT_NOTICE' });
    assert.equal((await restored.send({ type: 'GET_STATE' })).limitNotice, null);
  });
}

test('failed break-expiry notification reuses an existing overview and expires at reset', async () => {
  const state = stateWith(0);
  E.usage(state, 'example.com').breakUntil = now + 1000;
  const h = await harness({ now, storage: { scrollguardV4: state }, failNotifications: true, tabs: [
    { id: 1, url: 'https://example.com' },
    { id: 2, windowId: 3, active: false, url: 'chrome-extension://test-extension/options/options.html#settings' },
  ] });
  h.advance(1001); h.chrome.alarms.onAlarm.emit({ name: 'deadline' }); await h.flush();
  assert.equal(h.created.length, 0);
  assert.match(h.currentTabs.get(2).url, /#overview$/);
  assert.deepEqual(h.focusedWindows, [3]);
  assert.match((await h.send({ type: 'GET_STATE' })).limitNotice, /time limit/);
  h.setTime(E.nextReset(now));
  assert.equal((await h.send({ type: 'GET_STATE' })).limitNotice, null);
});

test('notification preview is trusted, does not change preferences, and reports permission failures', async () => {
  const state = stateWith(); state.settings.notifications = false;
  const h = await harness({ now, storage: { scrollguardV4: state } });
  const untrusted = { id: 'test-extension', url: 'https://example.com', tab: { id: 1 }, frameId: 0 };
  assert.equal((await h.send({ type: 'TEST_NOTIFICATION' }, untrusted)).ok, false);
  assert.equal(h.notifications.length, 0);
  assert.match((await h.send({ type: 'TEST_NOTIFICATION' })).message, /Test sent/);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.read().settings.notifications, false);
  assert.equal(h.created.length, 0);
  const denied = await harness({ now, notificationPermission: 'denied' });
  const response = await denied.send({ type: 'TEST_NOTIFICATION' });
  assert.equal(response.ok, false);
  assert.match(response.error, /notifications are disabled/);
});

test('existing installs enable closure notifications once and later preferences survive reload', async () => {
  const state = stateWith();
  delete state.closureNotificationsVersion;
  state.settings.notifications = false;
  state.pending = { settings: { ...state.settings }, sites: structuredClone(state.sites) };
  const h = await harness({ now, storage: { scrollguardV4: state } });
  assert.equal(h.read().settings.notifications, true);
  assert.equal(h.read().pending.settings.notifications, true);
  assert.equal(h.read().closureNotificationsVersion, 1);
  await h.send({ type: 'SAVE_SETTINGS', settings: { ...h.read().settings, notifications: false } });
  const restored = await harness({ now, storage: h.storage });
  assert.equal(restored.read().settings.notifications, false);
});
