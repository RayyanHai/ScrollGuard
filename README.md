# ScrollGuard

ScrollGuard tracks active website use and closes a website's tabs when its daily limit is reached. Complete math problems to unlock an elapsed-clock break. **Resets Daily at 6:00 AM** in your local timezone.

## Install or update

1. Keep this repository in a stable folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin ScrollGuard, open it, and choose **Manage websites**.
5. Add a website, set its daily allowance, and grant access when Chrome asks.

For an existing installation, click **Reload** on the extension card. Reload previously open Instagram/TikTok pages to remove the old version's injected overlay. No build step or server is needed.

The same installation steps apply to Chrome on macOS and Windows. Chrome 120 or later is required. This repository contains a Chrome Manifest V3 extension; it is not a native Mac app or a Safari extension. It affects websites in the browser profile where you installed it, not the TikTok desktop/mobile app or other browser profiles.

## How it works

- Website rules are editable; Instagram and TikTok are not the only supported sites.
- A daily allowance counts active use in the selected tab of the focused browser window. Background tabs do not multiply usage. Optional idle detection pauses the daily counter.
- A website's allowance is shared across its tabs. Once exhausted, all matching tabs close, and new matching tabs close too.
- After ScrollGuard closes a website, it sends a desktop notification titled **ScrollGuard**: **You've reached your time limit for [nickname]**. This also applies when an earned break expires. Notifications are enabled by default and can be disabled in Settings. Closing a tab yourself does not trigger one.
- The popup offers **Earn a break**. A dedicated challenge page presents one question at a time and saves progress.
- Finish the required number of questions to earn a break. There is **no challenge time limit**. A wrong answer keeps the same question and never removes progress.
- Breaks last **1–5 minutes of elapsed clock time**. Switching away, closing the site, or restarting Chrome does not pause or renew them. Breaks cannot stack or be earned in advance.
- At 6 AM, daily allowances, break counts, and escalation reset. Unused breaks expire. If Chrome was closed, the reset happens when the extension next runs.
- Usage totals include active use during earned breaks. A break does not erase the original daily usage.

Chrome scheduling and suspension can delay enforcement. Foreground heartbeats target approximately one-second accounting; browser events and persisted deadlines provide recovery. Sleep and long missing-heartbeat gaps are not charged as active use. A break deadline remains a wall-clock timestamp.

## Simple math settings

| Difficulty | Problems | Example |
| --- | --- | --- |
| Easy | Small-number addition | `8 + 6` |
| Normal | Addition and subtraction | `47 − 19` |
| Hard | Multiplication and exact division | `84 ÷ 7` |
| Extra Hard | Two-step arithmetic | `(18 × 7) − 24` |

Choose a difficulty and the number of questions. The settings screen shows one example for every level. Defaults are Normal, five questions, and a one-minute break.

Optional **Repeated breaks** settings increase question count and/or difficulty after successful grants, either per website or across all websites. Wrong answers and abandoned attempts never advance escalation. Escalation is off until enabled.

## Other settings

- Per website: daily minutes, subdomains, limit-and-close / track-only / off, earned breaks, and math/reward overrides.
- Breaks: 1–5 minutes per challenge; optional per-website caps on daily break count and total minutes granted. Zero means no cap.
- Preferences: automatically reopen the website, closure notifications, toolbar status, and idle detection.
- Settings protection: immediate edits (default), a math challenge to apply edits, or changes queued for the next 6 AM reset. Protection covers edits to existing rules and global settings, including its own setting. New website rules can be added immediately without applying pending changes early.
- Daily history: locally stored totals for up to 90 previous usage days, each running 6 AM–6 AM. Removing and re-adding a domain retains its current-day usage.

Settings-challenge completion does not award a break. Changes to rules invalidate outstanding challenges so old tasks cannot grant outdated rewards. Challenges also end at the daily reset.

## Data and upgrade behavior

Everything stays in `chrome.storage.local`. There is no account or backend. The extension stores domain rules, daily totals, settings, and challenge progress; it does not read page content. Additional website access is requested when that website is added. Removing Chrome's website permission pauses precise tracking and displays an **Enable access** prompt.

Version 4 imports the previous Instagram/TikTok limits and math preferences. Old storage keys remain available for recovery, but old midnight-based usage is not presented as new 6 AM usage. The new daily counter starts at zero and the popup displays a migration notice. Password-based unlocks, the old overlay, and the manual daily-reset button are no longer part of the new flow.

## Code map

| File | Responsibility |
| --- | --- |
| `lib/config.js` | Defaults, four difficulty previews, website and settings validation |
| `lib/engine.js` | Pure daily accounting, 6 AM boundaries, challenges, grants, escalation |
| `lib/storage.js` | Whole-state persistence and legacy migration |
| `background/service-worker.js` | Serialized browser events, tracking, tab closure, permissions, messages |
| `content/detector.js` | Visibility and one-second foreground heartbeat on configured sites |
| `lib/app.js`, `lib/ui.css` | Popup, overview, website manager, settings |
| `challenge/` | Persistent question-by-question challenge screen |

State uses a single `scrollguardV4` storage key. Completing a challenge and awarding its break commit in the same write. All service-worker mutations are serialized; submitting the same final answer twice cannot award two breaks. Content scripts cannot read private storage or invoke settings/challenge commands.

## Verification

Requires Node.js 20+ for development checks only:

```sh
npm test
npm run check
```

The dependency-free tests exercise accounting, domain matching, reset boundaries, challenge retries, duplicate submissions, tracking/focus, recovery after heartbeat and startup failures, settings protection, and migration. GitHub Actions runs them on Linux, macOS, and Windows on pushes and pull requests.

An optional real-browser smoke test is in `scripts/browser-smoke.js`. It needs Playwright and its Chromium browser. It uses `.test-profile/` (a disposable test profile), intercepts the test website locally, and writes screenshots to `test-results/`. It never uses your normal Chrome profile. Set `PLAYWRIGHT_MODULE` to a bundled Playwright path if it is not installed locally; set `PLAYWRIGHT_BROWSERS_PATH` if using a custom browser cache.

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/browser-smoke.js
```

Set `HEADED=1` to show the test browser window; keep it focused while the active-use timer runs. The smoke test covers active-use limits, one rejected heartbeat and recovery, native notification API calls, math challenges and saved progress, elapsed-clock break expiry, blocked revisits, a browser restart, and a simulated four-hour same-day gap. The time jump changes only the test worker's clock; it does not change your Mac/PC clock or represent a four-hour endurance run. Notifications are checked at the browser API level; operating-system banner delivery depends on system notification settings.

Tagging a release with `v*` packages the extension's runtime folders, including `challenge/`.

## License

All rights reserved. This project is published as a portfolio piece for reference. You may not copy, modify, or redistribute the code without permission.
