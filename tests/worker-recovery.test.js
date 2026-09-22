const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/config.js');
const E = require('../lib/engine.js');
const { harness } = require('./worker-harness.js');
const now = new Date('2026-09-16T12:00:00').getTime();

function blockedState() {
  const state = E.fresh(now);
  state.sites = [C.site({ domain: 'tiktok.com', limitMinutes: 1 })];
  E.usage(state, 'tiktok.com').baseMs = C.MINUTE;
  return state;
}

test('maintenance retries failed startup storage reads and restores persisted blocking', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }], failStorageReads: 2 });
  assert.equal(h.attempts.storageReads, 1);
  assert.ok(h.alarms.has('maintenance'), 'Recovery alarm exists even when startup fails');
  assert.deepEqual(h.removed, []);

  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.attempts.storageReads, 2);
  assert.deepEqual(h.removed, []);

  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.attempts.storageReads, 3);
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.read().usage['tiktok.com'].baseMs, C.MINUTE);
  assert.equal((await h.send({ type: 'GET_STATE' })).sites[0].status, 'blocked');
});

test('the first message after a startup registration failure retries startup before answering', async () => {
  const h = await harness({ now, storage: { scrollguardV4: blockedState() },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }], failRegistrations: 1 });
  assert.deepEqual(h.removed, []);
  const reply = await h.send({ type: 'GET_STATE' });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.sites[0].status, 'blocked');
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.attempts.registrations, 2);
});

test('failed startup attempts do not charge time before tracking resumes', async () => {
  const state = blockedState();
  state.usage['tiktok.com'].baseMs = 10_000;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }], failStorageReads: 2 });
  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.read().usage['tiktok.com'].baseMs, 10_000);
  h.advance(1000);
  await h.pulse(1);
  assert.equal(h.read().usage['tiktok.com'].baseMs, 11_000);
});

test('maintenance repairs a lost heartbeat after hours and the daily reset', async () => {
  const state = blockedState();
  state.sites[0].limitMinutes = .05;
  state.usage['tiktok.com'].breakUntil = now + 60_000;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }] });
  await h.pulse(1);
  // Model a missed deadline during machine sleep, followed by a new usage day.
  h.setTime(new Date('2026-09-17T08:00:00').getTime());
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.executions.length, 2, 'A stale detector is reinjected');
  assert.equal(h.read().day, '2026-09-17');
  assert.equal(h.read().usage['tiktok.com'].baseMs, 0, 'Sleep is not active use');

  // The repaired detector resumes sending pulses; the new allowance is finite.
  await h.pulse(1);
  for (let i = 0; i < 3; i++) { h.advance(1000); await h.pulse(1); }
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.read().usage['tiktok.com'].baseMs, 3000);
});

test('heartbeat repair retries failed injection and stops reseeding once pulses resume', async () => {
  const state = blockedState();
  state.usage['tiktok.com'].baseMs = 0;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }], failExecutions: 2 });
  for (let i = 0; i < 2; i++) {
    h.advance(30_000);
    h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
    await h.flush();
  }
  assert.equal(h.executions.length, 3);
  assert.equal(h.read().usage['tiktok.com'].baseMs, 0);
  await h.pulse(1);
  h.advance(1000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.executions.length, 3, 'A healthy heartbeat is not reinjected');
  assert.equal(h.read().usage['tiktok.com'].baseMs, 1000);
});

test('stale hidden visibility and navigation do not prevent heartbeat repair', async () => {
  const state = blockedState();
  state.usage['tiktok.com'].baseMs = 0;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }] });
  await h.pulse(1, false);
  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.executions.length, 2, 'Stored visibility may be stale after a lost pulse');
  await h.pulse(1);
  const tab = { ...h.currentTabs.get(1), url: 'https://www.tiktok.com/new' };
  h.currentTabs.set(1, tab);
  h.chrome.tabs.onUpdated.emit(1, { url: tab.url }, tab);
  await h.flush();
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.executions.length, 3, 'A new document cannot inherit the previous heartbeat');
});

test('an expired break still closes after hours with no heartbeat before the daily reset', async () => {
  const state = blockedState();
  state.usage['tiktok.com'].breakUntil = now + 60_000;
  const h = await harness({ now, storage: { scrollguardV4: state },
    tabs: [{ id: 1, url: 'https://www.tiktok.com/' }] });
  await h.pulse(1);
  h.advance(4 * 60 * C.MINUTE);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.executions.length, 1, 'Blocked tabs close before detector repair');
});

test('a failed permission refresh retries configuration and restores tracking', async () => {
  const state = blockedState();
  state.usage['tiktok.com'].baseMs = 0;
  const options = { now, storage: { scrollguardV4: state }, tabs: [{ id: 1, url: 'https://www.tiktok.com/' }] };
  const h = await harness(options);
  await h.pulse(1);
  options.failPermissionChecks = 2;
  h.chrome.permissions.onAdded.emit();
  await h.flush();
  assert.equal(h.attempts.permissionChecks, 2);

  h.advance(30_000);
  h.chrome.alarms.onAlarm.emit({ name: 'maintenance' });
  await h.flush();
  assert.equal(h.attempts.permissionChecks, 3, 'Maintenance retries an incomplete permission refresh');
  await h.pulse(1);
  h.advance(1000);
  await h.pulse(1);
  assert.equal(h.read().usage['tiktok.com'].baseMs, 1000);
});
