const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../content/detector.js'), 'utf8');

function detector(sendMessage) {
  const timers = new Map(), listeners = new Map();
  let nextTimer = 0;
  const document = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn) };
  const context = vm.createContext({ document,
    window: { addEventListener: (type, fn) => listeners.set(type, fn) },
    chrome: { runtime: { id: 'test-extension', sendMessage } },
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const inject = () => vm.runInContext(source, context);
  inject();
  return { document, timers, listeners, context, flush, inject,
    async tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'the heartbeat must schedule another attempt');
      timers.delete(entry[0]);
      await entry[1].fn();
      await flush();
    },
  };
}

test('a transient worker messaging error retries instead of disabling tracking forever', async () => {
  let calls = 0;
  const d = detector(async () => {
    calls++;
    if (calls === 1) throw new Error('The message port closed before a response was received.');
    return { tracking: true };
  });
  await d.flush();
  await d.tick();
  await d.tick();
  assert.equal(calls, 3);
  assert.equal(d.timers.size, 1);
});

test('reinjection recovers after a failed message without creating duplicate heartbeat loops', async () => {
  let calls = 0;
  const d = detector(async () => {
    if (++calls === 1) throw new Error('Service worker unavailable');
    return { tracking: true };
  });
  await d.flush();
  d.inject();
  await d.flush();
  assert.equal(calls, 2);
  assert.equal(d.timers.size, 1);
  await d.tick();
  assert.equal(calls, 3);
});

test('a visibility change during a request sends the new state and leaves one timer', async () => {
  const messages = [];
  let finish;
  const d = detector(message => {
    messages.push(message);
    if (messages.length === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ tracking: true });
  });
  d.document.hidden = true;
  d.listeners.get('visibilitychange')();
  d.inject();
  assert.equal(messages.length, 1);
  finish({ tracking: true });
  await d.flush();
  await d.tick();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].visible, false);
  assert.equal(d.timers.size, 0);
  d.document.hidden = false;
  d.listeners.get('pageshow')();
  await d.flush();
  assert.equal(messages[2].visible, true);
  assert.equal(d.timers.size, 1);
});

test('disabled tracking resumes on reinjection and an invalidated context stops retrying', async () => {
  let tracking = false, calls = 0;
  const d = detector(async () => { calls++; return { tracking }; });
  await d.flush();
  assert.equal(d.timers.size, 0);
  tracking = true;
  d.inject();
  await d.flush();
  assert.equal(d.timers.size, 1);
  d.context.chrome.runtime.id = undefined;
  await d.tick();
  assert.equal(calls, 2);
  assert.equal(d.timers.size, 0);
});

test('repeated worker startup failures back off even when startup reinjects the detector', async () => {
  let d;
  d = detector(async () => {
    // Model a worker that reinjects during initialization, then fails to save.
    await Promise.resolve();
    d.inject();
    return { ok: false, error: 'Temporary storage failure' };
  });
  await d.flush();
  for (let i = 0; i < 4; i++) {
    assert.equal(d.timers.size, 1);
    assert.equal([...d.timers.values()][0].delay, 1000, 'Failures must not form a zero-delay retry loop');
    await d.tick();
  }
});
