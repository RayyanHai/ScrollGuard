<p align="center">
  <img src="icons/icon-192.png" alt="ScrollGuard logo" width="160">
</p>

<h1 align="center">ScrollGuard</h1>

<p align="center">
  A Chrome extension that tracks Instagram usage by context (reels, stories, feed, DMs, explore, profile) and blocks you when you've spent too long in any of them. Built as a personal behavioral-intervention tool — not a polished product.
</p>

---

Whenever you hit a time limit (that you set) on reels or just by scrolling through your IG feed on the website, the extension will take over the page with a full-screen block overlay and pause anything in the background until the cooldown (that you set) expires or you enter a password for a short grace period. 

## Screenshots
<p align="center">
  <img width="340" height="598" alt="Screenshot 2026-05-11 at 7 54 08 PM" src="https://github.com/user-attachments/assets/ae8a3dcd-ff83-4add-8514-f2b750c5f505" />
</p>

<p align="center">
  <img width="1464" height="799" alt="Screenshot 2026-05-11 at 7 55 03 PM" src="https://github.com/user-attachments/assets/1404b497-83a8-4beb-bd17-d5613de72b83" />
</p>


## Why I built this

Even when I block doomscrolling apps on my phone, I sometimes still scroll on my computer. I wanted to make my own app to address my specific needs and enhance my learning of CI/CD and JavaScript. 

## What I learned

- **Manifest V3's service worker lifecycle.** Wrote my first extension on V3 and immediately hit the "service worker died, where did my state go" wall. The fix — making state a value in storage rather than a process in memory — generalized well. Same pattern shows up in REST APIs and JWT auth: stateless services that derive state from persisted data are more resilient than stateful processes.

- **CSS isolation is harder than it looks on production sites.** First version of the overlay used regular DOM nodes with prefixed classnames. Instagram's CSS still leaked through (their stylesheet has very specific selectors). Rebuilt in Shadow DOM and the problem disappeared. Now I reach for Shadow DOM by default any time I'm injecting UI into a site I don't control.

- **Message passing between SW and content scripts.** `chrome.runtime.sendMessage` is async and surprisingly easy to deadlock if you await responses incorrectly. Learned to keep the SW the source of truth and treat the content script as a thin renderer that fires events and updates the DOM.

- **The cost of cross-tab state.** I started with a global session model and tried to reconcile multiple tabs. After two days of edge-case whack-a-mole, I scrapped it and made sessions per-tab. The redesign was a few hours; the original approach would have been a maintenance burden forever. Worth doing the math on coordination cost early.

- **Self-imposed friction is a real design space.** The password isn't security. It's a few seconds of typing meant to interrupt the autopilot reach for the bypass button. Designing for "interrupt the impulse without being unusable" is a different problem than designing for "stop a hostile user," and the constraints flip in interesting ways.

## Tech Stack
- **JavaScript**
- **GitHub Actions** Automated release packaging
- **Chrome Extension Manifest V3** Service Worker + Content Scripts
- **Shadow DOM** For the overlay

## Features

- **Per-context tracking.** Reels, stories, IG feed, profile, and DM's are all tracked separately. DM's do not count towards the limit.
- **Active vs Passive Time** Reels and stories only count time when the tab is focused and visible. Closing your device or switching tabs stops the clock.
- **Block + cooldown.** When a group hits its limit, every context in that group is blocked for the full cooldown duration (default 30 min).
- **Password** A correct password buys you a fixed unlock window (default 30 sec), then the block resumes for the rest of its cooldown.
- **Session classification.** Each Instagram session is classified at end as `quick_check` (<60s), `browsing` (1–5 min), or `deep_scroll` (>5 min) for retrospective awareness. Each session of usage is classified as either a *quick check* (<60s), *browsing* (1-5min) or a *deep scroll* (>5 minutes).
- **Popup dashboard.**  Extension dashboard displays daily active time with threshold-based coloring, session count, session classification, current block countdowns, and time limit settings. 
- **Edge Cases** Any restarts, browser shutdown, or device shutdowns fail to break the blocker. All state lives in `chrome.storage.local`.

## Install

Download the latest release: [Releases page](https://github.com/RayyanHai/ScrollGuard/releases/latest)

1. Download `scrollguard-vX.Y.Z.zip`
2. Unzip it somewhere stable (not your Downloads folder)
3. Open `chrome://extensions`
4. Enable Developer mode (top-right)
5. Click "Load unpacked" and select the unzipped folder

## Configuration

Edit settings to your liking.
| Setting | What it does |
|---|---|
| Scroll limit | Combined cap for feed + stories before blocking |
| Reels limit | Cap for reels alone |
| Other limit | Cap for explore + profile + uncategorised pages |
| Block cooldown | How long the block stays active after a limit hit |
| Unlock grace | How long the password unlocks you for |
| Password | The phrase you type to bypass an active block |

- Scroll Limit: Time limit for feed + stories
- Reels Limit: Time limit for just reels
- Other limit: Time limit for explore, profile, and other random pages
- Block cooldown: How long your IG is blocked for after reaching a limit
- Unlock Grace: How much time a password unlock grants you
- Password: Phrase to bypass a block

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

## License

All rights reserved. This project is published as a portfolio piece for reference. You may not copy, modify, or redistribute the code without permission.
