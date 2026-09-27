# ScrollGuard for macOS

This download is a Chrome extension, not a native Mac app or Safari extension. It requires Chrome 120 or later. The same extension works with Chrome on Apple silicon and Intel Macs that support that browser version.

1. Double-click the downloaded ZIP in Finder to extract it.
2. Keep the extracted folder somewhere permanent, such as Documents/ScrollGuard.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Pin ScrollGuard, open **Manage websites**, and add a website and its daily limit. Allow website access when Chrome asks.

## Enable time-limit notifications

1. In ScrollGuard **Settings**, leave **Notify me when ScrollGuard closes a website** enabled.
2. Click **Test notification**. The preview does not change your settings or website limits. If macOS asks whether Chrome may send notifications, allow it.
3. Open **Apple menu → System Settings → Notifications → Google Chrome** and enable **Allow notifications**. Choose a desktop alert style. If Chrome is not listed yet, send a test notification first.
4. Check **Focus / Do Not Disturb** if banners are still missing. Older macOS versions call System Settings **System Preferences**.

When an allowance or earned break runs out, ScrollGuard closes that website's tabs and sends a notification with the website nickname. Clicking it opens your Activity overview, where you can earn a break. If Chrome denies or fails to send the notification, ScrollGuard opens the overview with a dismissible time-limit alert instead. macOS can silence banners even when Chrome accepts the notification; ScrollGuard cannot override system settings.

[Apple's notification settings guide](https://support.apple.com/guide/mac-help/notifications-settings-mh40583/mac)

## Update an existing installation

Keep the same installation folder and Chrome profile to preserve extension identity and locally stored settings. Replace the files in that folder with this download's contents, then click **Reload** on ScrollGuard's card in `chrome://extensions`. Reload previously open tracked websites too. Do not remove the installed extension first; removing it deletes its local data.

Daily limits reset at **6:00 AM local time**. It affects websites in this Chrome profile, not native apps or other browser profiles. See `README.md` for behavior, upgrade details, and limitations.
