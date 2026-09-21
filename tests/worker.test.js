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
  assert.deepEqual(h.notifications[0].closedTabIds, [1, 2]);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' }); await h.flush();
  assert.equal(h.notifications.length, 1);
  const retry = { id: 3, windowId: 1, active: true, url: 'https://example.com/again' };
  h.currentTabs.set(3, retry); h.chrome.tabs.onCreated.emit(retry); await h.flush();
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].message, "You've reached your time limit for My videos");
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
  const failure = await harness({ now, storage: { scrollguardV4: stateWith(0) },
    tabs: [{ id: 2, url: 'https://example.com' }], failRemoval: [2] });
  assert.equal(failure.notifications.length, 0);
  assert.ok(failure.currentTabs.has(2));
});

test('users can disable closure notifications without disabling tab closure', async () => {
  const state = stateWith(0); state.settings.notifications = false;
  const h = await harness({ now, storage: { scrollguardV4: state }, tabs: [{ id: 1, url: 'https://example.com' }] });
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.notifications.length, 0);
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
