# ScrollGuard

A Chrome extension that tracks Instagram usage by context (reels, stories, feed, DMs, explore, profile) and blocks you when you've spent too long in any of them. Built as a personal behavioral-intervention tool — not a polished product.

When you hit a limit, ScrollGuard takes over the page with a full-screen block overlay, pauses any playing video, and refuses to let you scroll until either the cooldown expires or you type your password for a short grace window.

## Features

- **Per-context tracking.** Distinguishes between reels, stories, feed, DMs, explore, and profile pages by URL. DMs are deliberately exempt from blocking.
- **Strict vs lenient time accounting.** Reels and stories only count time when the tab is focused, visible, and the active tab — closing your laptop or switching tabs stops the clock. Feed and DMs count whenever the URL is loaded.
- **Group-based limits.** Feed + stories share one limit, reels has its own, explore + profile + everything-else share a third. Limits are configurable from the popup.
- **Block + cooldown.** When a group hits its limit, every context in that group is blocked for the full cooldown duration (default 30 min).
- **Password unlock with grace window.** A correct password buys you a fixed unlock window (default 5 min), then the block resumes for the rest of its cooldown.
- **Session classification.** Each Instagram session is classified at end as `quick_check` (<60s), `browsing` (1–5 min), or `deep_scroll` (>5 min) for retrospective awareness.
- **Popup dashboard.** Today's per-group active time with threshold-based coloring (blue → yellow → red), session count, classification breakdown, and current block countdowns.
- **Manual lock-now and reset-today buttons.** For when you feel a doomscroll coming, or want to start fresh.
- **Survives reloads, SW restarts, and browser restarts.** All state lives in `chrome.storage.local`.

## Install (unpacked)

ScrollGuard isn't on the Chrome Web Store — it's a personal tool. To install:

1. Clone this repo.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked**, select the `ScrollGuard/` folder.
5. Pin the icon from the puzzle-piece toolbar menu.

The extension only runs on `*.instagram.com` — it has no permissions on any other site.

## Configuration

Most settings are editable from the popup (click the toolbar icon → "edit"):

| Setting | What it does |
|---|---|
| Scroll limit | Combined cap for feed + stories before blocking |
| Reels limit | Cap for reels alone |
| Other limit | Cap for explore + profile + uncategorised pages |
| Block cooldown | How long the block stays active after a limit hit |
| Unlock grace | How long the password unlocks you for |
| Password | The phrase you type to bypass an active block |

Defaults that aren't in the popup live in [`lib/config.js`](lib/config.js).

## How it works

```
nav events  →  per-tab session/segment tracking
              ↓
           1-second tick
              ↓
   per-group active-time accumulator
              ↓
       limit check → block state
              ↓
   content script BLOCK / UNLOCK / CLEAR
```

- **Service worker** (`background/service-worker.js`) is the brain. Listens to `webNavigation`, `tabs`, and `windows` events; runs a 1-second `setInterval` that decides what state each tab should be in.
- **Content script** (`content/detector.js`, `content/intervention.js`) runs in the Instagram page. Reports Page Visibility, renders the block overlay in a Shadow DOM, pauses videos when blocked.
- **Storage** (`chrome.storage.local`, wrapped in `lib/storage.js`) holds in-flight sessions, completed sessions bucketed by date, the per-group active-time counter, the current block state, and user-edited config.

A few non-obvious design choices, in case you fork this:

- **MV3 service workers die after ~30s of inactivity.** The 1s tick doesn't keep them alive, by design. The content-script overlay's countdown uses the absolute `blockedUntil` timestamp as the source of truth and tears itself down optimistically when the timestamp passes — no need for the SW to be awake.
- **Strict vs lenient gating** combines three signals (`tabs.onActivated`, `windows.onFocusChanged`, Page Visibility from the content script). The first two live in the SW, the third is pushed via message-passing.
- **Block evaluation is per-group, not per-context.** Feed time and stories time accumulate into a shared "scroll" bucket, and the cooldown blocks both contexts together. This matches the user-facing feature ("scroll for too long → blocked") rather than the implementation detail of which URL fired the limit.
- **Password verification happens in the SW**, not the content script — so a malicious or curious user can't read it from the page's DevTools.
- **Per-tab sessions, not a global one.** If you have Instagram open in two tabs, you get two sessions that sum on the dashboard. Simpler than reconciling cross-tab focus.

## File layout

```
ScrollGuard/
├── manifest.json
├── background/service-worker.js     # rules engine, tick, storage writes
├── content/
│   ├── detector.js                  # context detection + visibility reporting
│   └── intervention.js              # block overlay, video pause, password input
├── popup/                           # toolbar dropdown UI
├── lib/
│   ├── classifier.js                # URL → context (shared between SW and content)
│   ├── config.js                    # default limits, password, cooldown, grace
│   └── storage.js                   # chrome.storage.local wrapper
└── icons/
```

## Notes

- This is **not** a security tool. The password is stored in plaintext in `chrome.storage.local` because it's a self-imposed friction layer, not a credential. Anyone with `chrome://extensions` DevTools access can read or change it. The point is to make bypass annoying enough that you reflect, not impossible.
- Built as a learning project — clean comments throughout for anyone (including future-me) reading the rule-engine logic.
- No analytics, no network calls, no third-party dependencies. Just vanilla JS.

## License

MIT.
