// Content-script side of context detection + Page Visibility reporting.
//
// classifyContext is provided by lib/classifier.js (loaded before this file
// per manifest.json's content_scripts.js order — content scripts in the same
// entry share an isolated-world global scope, so it's just available here).
//
// Why we ALSO classify on the content side instead of trusting the SW:
//  1. Race on first load — the content script can be ready before the SW's
//     onCommitted fires its message; we want a context immediately.
//  2. The SW can be terminated and restarted by Chrome at any time. The
//     content script lives as long as the page does and survives SW death.
//  3. Cheap: a regex-ish check on location.href.
//
// Visibility reporting (added in step 4):
// The Page Visibility API only exists in the page context, not the SW. We
// push visibility state changes to the SW so it can include them in the
// active-time decision for "strict" contexts (reels, stories).

let currentContext = classifyContext(location.href);
console.log('[ScrollGuard] initial context:', currentContext, '|', location.href);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'CONTEXT_CHANGE') return;
  if (msg.context === currentContext) return;
  const prev = currentContext;
  currentContext = msg.context;
  console.log('[ScrollGuard] context changed:', prev, '→', currentContext, '|', msg.url);
});

// --- Visibility reporting --------------------------------------------------

function reportVisibility() {
  chrome.runtime.sendMessage({
    type: 'VISIBILITY',
    visible: !document.hidden,
  }).catch(() => {});
}

document.addEventListener('visibilitychange', reportVisibility);
// Initial report — the SW assumes "not visible" until told otherwise, so a
// freshly loaded foreground tab needs to announce itself.
reportVisibility();

window.__scrollguard = {
  get context() { return currentContext; },
  get visible() { return !document.hidden; },
};
