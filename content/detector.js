/* A small heartbeat only on user-configured websites; never reads page content. */
(() => {
  if (globalThis.__scrollguardHeartbeat) { globalThis.__scrollguardHeartbeat(); return; }
  let timer = null, stopped = false;
  async function pulse() {
    clearTimeout(timer);
    if (stopped) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'PULSE', visible: !document.hidden });
      if (reply?.tracking === false) return;
    } catch { stopped = true; return; }
    if (!document.hidden) timer = setTimeout(pulse, 1000);
  }
  globalThis.__scrollguardHeartbeat = pulse;
  document.addEventListener('visibilitychange', pulse);
  window.addEventListener('pageshow', pulse);
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    chrome.runtime.sendMessage({ type: 'PULSE', visible: false }).catch(() => {});
  });
  pulse();
})();
