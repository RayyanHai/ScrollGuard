# ScrollGuard v4.0.1 — Custom website fix and YouTube Shorts

Download **scrollguard-v4.0.1-windows.zip** or **scrollguard-v4.0.1-macos.zip** below. Both contain the same Chrome extension with setup instructions for their platform. Chrome 120+ is required.

## Fixed: adding your own websites

Adding a website such as YouTube could fail with “Only permissions specified in the manifest may be requested.” ScrollGuard now requests website access using the HTTP and HTTPS patterns declared in its manifest. This fixes adding custom websites and restoring their access.

Access is still requested only for the website you add. Chrome may ask you to approve it.

## YouTube Shorts only

- Enter `youtube.com/shorts`, or enter `youtube.com` and choose **YouTube Shorts only**.
- Only `/shorts` pages use this allowance and close when the limit is reached. Regular YouTube videos remain available.
- Moving between regular videos and Shorts within the same tab updates tracking automatically.
- Earned breaks reopen Shorts. Existing YouTube rules continue to cover all of YouTube until you edit their scope.
- There is one rule per domain. Changing a rule's scope keeps its existing daily usage.

## Update without losing settings

Extract the download and replace the files in your existing ScrollGuard installation folder. Open `chrome://extensions`, click **Reload** on ScrollGuard, and reload open YouTube or other tracked website tabs. Reopen ScrollGuard's settings page before adding your rule.

Keep the same installation folder and Chrome profile. **Do not uninstall first**, because that deletes locally stored settings and usage.

For a new installation, follow the included `INSTALL.md`.

## Verification

Publication is gated on automated tests and resource checks on Windows, macOS, and Linux, plus real Chromium tests of the packaged Windows and macOS downloads. The browser tests now cover an optional website's native permission request, saved Shorts scope, same-tab navigation, paused accounting outside Shorts, and closing only Shorts tabs. Existing tests continue to cover math breaks, notifications, and restart recovery.

SHA-256 checksums are included in **SHA256SUMS.txt**.
