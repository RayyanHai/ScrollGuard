const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)), listeners };
}
async function harness(options = {}) {
  let now = options.now || new Date('2026-09-16T12:00:00').getTime();
  let nextTab = 100;
  const storage = structuredClone(options.storage || {});
  const currentTabs = new Map((options.tabs || []).map(t => [t.id, { windowId: 1, active: true, ...t }]));
  const removed = [], created = [], notifications = [], logs = [], registrations = new Map(), alarms = new Map();
  let focus = options.focus ?? 1;
  const runtime = { id: 'test-extension', getURL: p => `chrome-extension://test-extension/${p}`,
    onMessage: event(), onStartup: event() };
  const chrome = {
    runtime,
    storage: { local: {
      setAccessLevel: async () => {},
      get: async keys => Object.fromEntries(keys.filter(k => k in storage).map(k => [k, structuredClone(storage[k])])),
      set: async data => Object.assign(storage, structuredClone(data)),
    } },
    tabs: {
      query: async () => [...currentTabs.values()].map(t => ({ ...t })),
      get: async id => { if (!currentTabs.has(id)) throw new Error('No tab'); return { ...currentTabs.get(id) }; },
      remove: async id => {
        if (options.failRemoval?.includes(id)) throw new Error('Could not close tab');
        removed.push(id); currentTabs.delete(id);
      },
      create: async data => { const t = { id: nextTab++, windowId: 1, active: false, ...data }; created.push(t); currentTabs.set(t.id, t); return t; },
      update: async (id, data) => Object.assign(currentTabs.get(id), data),
      onActivated: event(), onUpdated: event(), onCreated: event(), onRemoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { WINDOW_ID_NONE: -1, getLastFocused: async () => ({ id: focus || 1, focused: focus != null }), update: async () => {}, onFocusChanged: event() },
    idle: { queryState: async () => 'active', setDetectionInterval: () => {}, onStateChanged: event() },
    permissions: { contains: async () => true, onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: async () => [...registrations.values()],
      registerContentScripts: async list => list.forEach(s => registrations.set(s.id, s)),
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => registrations.delete(id)), executeScript: async () => [] },
    alarms: { create: async (name, spec) => alarms.set(name, spec), onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { create: async data => {
      notifications.push({ ...data, closedTabIds: removed.slice() });
      return `notification-${notifications.length}`;
    } },
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ chrome, Date: ClockDate, URL, structuredClone, crypto,
    console: { log() {}, error: (...args) => logs.push(args) }, setTimeout: () => 1, clearTimeout() {} });
  const root = path.resolve(__dirname, '..');
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }));
  vm.runInContext(fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8'), context);
  async function flush() { await vm.runInContext('queue', context); }
  await flush();
  const sender = { id: runtime.id, url: runtime.getURL('options/options.html') };
  function send(message, from = sender) {
    return new Promise(resolve => runtime.onMessage.listeners[0](message, from, resolve));
  }
  return { chrome, send, flush, storage, removed, created, notifications, currentTabs, logs, alarms,
    now: () => now, advance: ms => { now += ms; }, setTime: value => { now = value; },
    async pulse(id, visible = true) {
      const tab = currentTabs.get(id);
      return send({ type: 'PULSE', visible }, { id: runtime.id, tab: { ...tab }, frameId: 0, url: tab?.url });
    },
    async focus(id) { focus = id; chrome.windows.onFocusChanged.emit(id ?? -1); await flush(); },
    read: () => structuredClone(storage.scrollguardV4),
  };
}
module.exports = { harness };
