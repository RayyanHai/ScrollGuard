/* A small heartbeat only on user-configured websites; never reads page content. */
(() => {
  if (globalThis.__scrollguardHeartbeat) { globalThis.__scrollguardHeartbeat(); return; }
  let timer = null, inFlight = false, pending = false;
  async function pulse() {
    clearTimeout(timer);
    // Visibility events and worker reinjection can arrive during a request.
    // Keep one loop per document, but send its newest visibility afterwards.
    if (inFlight) { pending = true; return; }
    if (!chrome.runtime?.id) return; // The extension was removed or reloaded.
    inFlight = true;
    let tracking = true, failed = false;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'PULSE', visible: !document.hidden });
      tracking = reply?.tracking !== false;
      failed = reply?.ok === false;
    } catch {
      // A worker restart or temporary message failure must not permanently
      // disable accounting for a still-open tab. Retry on the next heartbeat.
      failed = true;
    } finally {
      inFlight = false;
      // Startup retries can reinject this document while its request is still
      // pending. Back off on failure instead of feeding an immediate retry loop.
      if (pending || (tracking && !document.hidden)) timer = setTimeout(pulse, pending && !failed ? 0 : 1000);
      pending = false;
    }
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
