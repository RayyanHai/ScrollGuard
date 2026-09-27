# ScrollGuard v4.0.0 — Windows and macOS

Download **scrollguard-v4.0.0-windows.zip** or **scrollguard-v4.0.0-macos.zip** below. Both contain the same Chrome extension with an OS-specific `INSTALL.md`. They are unpacked Chrome extensions, not native installers or Safari extensions. Chrome 120+ is required.

## Time-limit notifications

- Desktop notifications name the website after its tabs close at the daily limit or earned-break deadline.
- Click a notification to open or focus your Activity overview and earn a break.
- If Chrome denies or fails to send a notification, the overview opens with a persistent, dismissible explanation.
- Settings includes **Test notification** and guidance for enabling browser notifications on Windows and macOS. OS Focus / Do not disturb can suppress banners even when Chrome accepts delivery.

## Also included since v3

- Editable website rules, active-tab daily accounting, and a daily reset at 6 AM local time.
- Persistent math challenges, configurable difficulty, 1–5 minute elapsed-clock breaks, optional escalation, and protected settings.
- Local usage history and recovery after interrupted heartbeats, sleep, and browser restarts.

## Install or update

Extract the appropriate ZIP, then follow its `INSTALL.md`. New installations use **Load unpacked** in `chrome://extensions`. Existing installations should replace files in the same installation folder and click **Reload**, keeping their browser profile and stored settings. Reload existing tracked website tabs. Do not uninstall the extension first.

Version 4 imports legacy website limits and math preferences. Daily usage starts fresh because the reset boundary changed from midnight to 6 AM; legacy data is retained separately.

## Verification

The release workflow gates publication on automated tests and resource checks on Windows, macOS, and Linux, plus real Chromium extension smoke tests using the packaged Windows and macOS downloads. Smoke tests cover native notification API attempts, notification failure fallback, active limits, math breaks, and restart recovery. They do not certify that a desktop banner is visible under every OS notification configuration; use **Test notification** on your machine.

SHA-256 checksums are included in **SHA256SUMS.txt**.
