// Reports Page Visibility changes to the service worker.
//
// The Page Visibility API (document.hidden / visibilitychange) only exists in
// the page context, not the SW. The SW uses this signal as one of three required
// conditions for counting "active time" on a tracked site (along with
// tab-active-in-window and window-focused, both of which the SW can detect
// on its own). Same script runs on every tracked platform (Instagram, TikTok).
//
// We send the initial state on script load because the SW assumes "not visible"
// until told otherwise.

function reportVisibility() {
  chrome.runtime.sendMessage({
    type: 'VISIBILITY',
    visible: !document.hidden,
  }).catch(() => {});
}

document.addEventListener('visibilitychange', reportVisibility);
reportVisibility();
