'use strict';
globalThis.UI = {
  async request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || 'ScrollGuard could not respond. Reload the extension and try again.');
    return response;
  },
  el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) node.append(child);
    return node;
  },
  duration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  },
  time(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
  difficulty(id) { return SG.DIFFICULTIES.find(d => d.id === id)?.label || id; },
  async page(hash = 'overview') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#${hash}`) });
  },
};
