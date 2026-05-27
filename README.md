<p align="center">
  <img src="icons/icon-192.png" alt="ScrollGuard logo" width="160">
</p>

<h1 align="center">ScrollGuard</h1>

<p align="center">
  A Chrome extension that tracks how long you spend on Instagram and TikTok each day and blocks you once you cross your daily limit on either. Built as a personal behavioral-intervention tool — not a polished product.
</p>

<p align="center">
  <a href="https://github.com/rayyanhai/ScrollGuard/releases/latest">
    <img src="https://img.shields.io/github/v/release/rayyanhai/ScrollGuard?style=flat-square&label=latest" alt="Latest release">
  </a>
</p>

---

Whenever you hit a daily time limit (that you set) on Instagram or TikTok in the browser, the extension will take over the page with a full-screen block overlay and pause anything in the background until the cooldown (that you set) expires or you enter a password for a short grace period. Each platform has its own independent daily counter and block state — burning your Instagram budget doesn't touch TikTok and vice versa.

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

- **GitHub Actions for release automation.** Wrote my first CI workflow that triggered on 'v*' tags and packages the extension and publishes a GitHub release. Small in scope, but the patterns generalize to every CI/CD platform.
  
- **Using Chrome Storage to survive outsmarting the blocker.** Manifest V3 service workers die after ~30 seconds of inactivity, which breaks any extension built around long-running timers. I used a single timestamp in chrome.storage.local so anytime IG is opened and it's in the block state, it just compares to the current clock. This means the block persists when IG is idle, when the browser restarts, when the entire computer restarts, and in pretty much anything. Storage outlives processes, and this is the same idea behind REST APIs, JWTs, and other distributed systems work.

- **Coordinating tricky parts of the design.** I initially planned to track time across all tabs, but was confused on how to figure out which one was the real session. After some edge cases, I decided to switch and calculate time based on independent tabs and sum them up in the dashboard at read time. This design choice saved a lot of maintenance later on.

- **Tracking Active Time.** I needed three separate signals to track the active amount of time spent on reels: chrome.tabs.onActivated (is it active in the window?), chrome.windows..onFocusChanged (is the window focused?), and the Page Visibility API (is the page visible as in it's not behind another window?). While I had these concerns during design, it was interesting to see how they were technically built into APIs and composed in code.

- **CSS isolation on a site I don't control.** When I first tried making the overlay using regular DOM nodes, IG's CSS still leaked through. I then rebuilt a shadow DOM, which was like an isolated bubble of HTML and CSS that the page couldn't reach into.

## Tech Stack
- **JavaScript**
- **GitHub Actions** Automated release packaging
- **Chrome Extension Manifest V3** Service Worker + Content Scripts
- **Shadow DOM** For the overlay

## Features

- **Independent per-platform tracking.** Instagram and TikTok each get their own daily counter, their own block state, and their own dashboard section. Settings (limit, cooldown, grace, password) are shared.
- **Daily time limit per platform.** ScrollGuard counts the total time you spend actively on each site, then blocks just that platform once you cross the limit.
- **Active vs Passive Time.** Counts only when you're actively focused on the tab (active + visible + window focused). Background tabs or minimized windows don't count.
- **Block + cooldown with auto-reset.** When you hit the daily limit, the platform is blocked for the full cooldown duration (default 30 min). Once the cooldown expires, that platform's counter resets to 0 — the cooldown IS the punishment, not a one-shot lockout.
- **Password.** A correct password buys you a fixed unlock window (default 5 min), then the block resumes for the rest of its cooldown. One password, both platforms.
- **Session classification.** Each session is classified at end as a *quick check* (<60s), *browsing* (1–5 min), or *deep scroll* (>5 min) for retrospective awareness.
- **Popup dashboard.** One section per platform with daily active time, threshold-based coloring, session count, classification breakdown, block countdowns, and Lock/Reset buttons.
- **Edge Cases.** Any restarts, browser shutdowns, or device shutdowns fail to break the blocker. All state lives in `chrome.storage.local`.

## Install

Download the latest release: [Releases page](https://github.com/RayyanHai/ScrollGuard/releases/latest)

1. Download `scrollguard-vX.Y.Z.zip`
2. Unzip it somewhere stable (not your Downloads folder)
3. Open `chrome://extensions`
4. Enable Developer mode (top-right)
5. Click "Load unpacked" and select the unzipped folder

**First run:** click the ScrollGuard icon and you'll be prompted to set your unlock password. Choose something memorable but annoying — that's the friction layer between you and bypassing a block. You can change it later from the settings panel.

> Working on the code? Skip the download and `git clone` the repo instead, then load that folder directly.

## Configuration

- Daily limit: Total time on Instagram per day before blocking
- Block cooldown: How long the block stays active after a limit hit
- Unlock grace: How much time a password unlock grants
- Password: Phrase to bypass an active block

## How it works

```
nav events  →  per-tab session tracking (tagged with platform)
              ↓
     30s chrome.alarms tick
              ↓
   per-platform active-time accumulator
              ↓
   limit check → per-platform block state
              ↓
   content script BLOCK / UNLOCK / CLEAR
```

- **Service worker** (`background/service-worker.js`) is the brain. Listens to `webNavigation`, `tabs`, and `windows` events; uses a `chrome.alarms` tick (every ~30s) to accumulate active time per platform and decide each platform's block state. When a platform's cooldown expires, its counter resets to 0.
- **Content script** (`content/detector.js`, `content/intervention.js`) runs in every tracked page (Instagram, TikTok). Reports Page Visibility, renders the block overlay in a Shadow DOM with platform-aware copy, and pauses videos when blocked.
- **Storage** (`chrome.storage.local`, wrapped in `lib/storage.js`) holds in-flight sessions, completed sessions bucketed by date, per-platform daily counters (`dailyActive[platform]`), per-platform block state (`blockState[platform]`), and user-edited config.
- **Platforms** are declared in `lib/config.js` (`SG_PLATFORMS`). Adding another site is a matter of adding one entry there plus the host pattern in `manifest.json`.

## Roadmap

Some things I have planned for the future of the project given more time:

- **More Platforms.** YouTube Shorts next — same scrolling pattern, same problem. The platform abstraction in `SG_PLATFORMS` makes adding sites straightforward.

- **Continuous Integration.** Add unit tests for the rules engine and run them on every PR

- **Dashboard data export.** Export the session log as JSON or CSV for any personal purposes.

## License

All rights reserved. This project is published as a portfolio piece for reference. You may not copy, modify, or redistribute the code without permission.
