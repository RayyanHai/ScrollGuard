const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/config.js');
const E = require('../lib/engine.js');
const { harness } = require('./worker-harness.js');

const now = new Date('2026-09-16T12:00:00').getTime();
const previous = 'https://work.test/document';
const blocked = 'https://www.instagram.com/reels/';

function blockedState() {
  const state = E.fresh(now);
  state.sites = [C.site({ domain: 'instagram.com', name: 'Instagram', limitMinutes: 0 })];
  return state;
}

test('a blocked committed visit returns the existing tab to its previous page and keeps focus', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: previous }, { id: 2, url: 'https://other.test/', active: false }] });
  await h.navigate(1, blocked);
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.equal(h.currentTabs.get(1).active, true);
  assert.equal(h.currentTabs.get(2).url, 'https://other.test/');
  assert.deepEqual(h.backCalls, [1]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.focusedWindows, []);
  assert.equal(h.notifications.length, 1);
  assert.match((await h.send({ type: 'GET_STATE' })).limitNotice, /previous page/);
});

test('a blocked pending visit preserves the current page without going farther back in history', async () => {
  const older = 'https://older.test/';
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: previous }], histories: { 1: [older] } });
  await h.navigate(1, blocked, { pending: true });
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.equal(h.currentTabs.get(1).pendingUrl, undefined);
  assert.deepEqual(h.histories.get(1), [older]);
  assert.deepEqual(h.backCalls, []);
  assert.deepEqual(h.removed, []);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.created.length, 0);
});

test('duplicate stale events cannot close a returned tab or go back twice', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: previous }], histories: { 1: ['https://older.test/'] } });
  const stale = { ...h.currentTabs.get(1), url: blocked };
  h.histories.get(1).push(previous);
  h.currentTabs.set(1, stale);
  h.chrome.tabs.onUpdated.emit(1, { url: blocked }, { ...stale });
  h.chrome.tabs.onUpdated.emit(1, { status: 'complete' }, { ...stale });
  await h.flush();
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.deepEqual(h.backCalls, [1]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.notifications.length, 1);
});

test('Back may finish asynchronously without duplicate returns or closure during loading', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: previous }], deferBack: [1] });
  await h.navigate(1, blocked);
  assert.equal(h.currentTabs.get(1).url, blocked, 'The browser has not committed Back yet');
  h.advance(1000);
  const loading = { ...h.currentTabs.get(1) };
  h.chrome.tabs.onUpdated.emit(1, { status: 'loading' }, loading);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  await h.pulse(1);
  assert.deepEqual(h.backCalls, [1]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.notifications.length, 1);
  await h.completeBack(1);
  assert.equal(h.currentTabs.get(1).url, previous);
  await h.navigate(1, blocked);
  await h.completeBack(1);
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.deepEqual(h.backCalls, [1, 1], 'A later blocked visit is handled independently');
  assert.equal(h.notifications.length, 2);
});

test('a fresh worker returns an already committed blocked visit using browser history', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: blocked }], histories: { 1: [previous] } });
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.deepEqual(h.backCalls, [1]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.created.length, 0);
  assert.equal(h.notifications.length, 1);
});

test('failed Back restores a known safe page without closing the existing tab', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: previous }], failBack: [1] });
  await h.navigate(1, blocked);
  assert.equal(h.currentTabs.get(1).url, previous);
  assert.deepEqual(h.backCalls, [1]);
  assert.deepEqual(h.updated, [{ id: 1, url: previous }]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.created.length, 0);
});

test('Chromium initial about:blank history is not treated as a previous page', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: blocked }], histories: { 1: ['about:blank'] } });
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.created.length, 1);
});

test('a delayed return to initial about:blank still closes the empty tab', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: blocked }], histories: { 1: ['about:blank'] }, deferBack: [1] });
  await h.completeBack(1);
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.currentTabs.has(1), false);
  assert.equal(h.notifications.length, 1, 'Finishing the same blocked visit must not notify twice');
  assert.equal(h.created.length, 1, 'The closed tab still opens the overview explanation');
});

for (const tab of [{ url: blocked }, { url: 'about:blank', pendingUrl: blocked }]) {
  test(`a new blocked tab without a previous page closes: ${tab.url}`, async () => {
    const h = await harness({ now, storage: { scrollguardV4: blockedState() } });
    const created = { id: 1, windowId: 1, active: true, ...tab };
    h.currentTabs.set(1, created);
    h.chrome.tabs.onCreated.emit(created);
    await h.flush();
    assert.deepEqual(h.removed, [1]);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.created.length, 1, 'Closing a tab retains the overview notification fallback');
    assert.match(h.created[0].url, /options\/options.html#overview$/);
  });
}

for (const configuration of [
  { label: 'disabled', enabled: false },
  { label: 'OS permission denied', enabled: true, notificationPermission: 'denied' },
  { label: 'native delivery failed', enabled: true, failNotifications: true },
]) {
  test(`returned pages keep focus when notifications are ${configuration.label}`, async () => {
    const state = blockedState();
    state.settings.notifications = configuration.enabled;
    const h = await harness({ now, storage: { scrollguardV4: state }, ...configuration,
      tabs: [{ id: 1, url: previous },
        { id: 2, active: false, url: 'chrome-extension://test-extension/options/options.html#settings' }] });
    await h.navigate(1, blocked);
    assert.equal(h.currentTabs.get(1).url, previous);
    assert.equal(h.currentTabs.get(1).active, true);
    assert.equal(h.currentTabs.get(2).active, false);
    assert.match(h.currentTabs.get(2).url, /#settings$/);
    assert.equal(h.created.length, 0);
    assert.deepEqual(h.focusedWindows, []);
    assert.deepEqual(h.removed, []);
    assert.equal(h.notifications.length, 0);
    const reply = await h.send({ type: 'GET_STATE' });
    if (configuration.enabled) assert.match(reply.limitNotice, /previous page/);
    else assert.equal(reply.limitNotice, null);
  });
}

test('a remembered fallback whose break has expired is not reopened when Back fails', async () => {
  const state = blockedState();
  state.sites.push(C.site({ domain: 'work.test', limitMinutes: 0 }));
  E.usage(state, 'work.test').breakUntil = now + 1000;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: previous }], failBack: [1] });
  h.advance(1001);
  await h.navigate(1, blocked);
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.updated.some(update => update.url === previous), false);
  assert.equal(h.currentTabs.has(1), false);
});
