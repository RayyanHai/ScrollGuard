# ScrollGuard for Windows

This download is a Chrome extension, not an EXE installer. It requires Chrome 120 or later and runs inside the browser profile where you install it.

1. Right-click the downloaded ZIP and choose **Extract All**.
2. Keep the extracted folder somewhere permanent, such as Documents/ScrollGuard.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Pin ScrollGuard, open **Manage websites**, and add a website and its daily limit. Allow website access when Chrome asks.

## Enable time-limit notifications

1. In ScrollGuard **Settings**, leave **Notify me when ScrollGuard closes a website** enabled.
2. Click **Test notification**. The preview does not change your settings or website limits.
3. In Windows 11, open **Settings → System → Notifications**. Enable notifications for **Google Chrome**, including **Show notification banners**. If Chrome is not listed yet, send a test notification first.
4. Check **Do not disturb** and its automatic rules if banners are still missing. In Windows 10 the corresponding panel is **Notifications & actions**, with **Focus assist** controlling interruptions.

When an allowance or earned break runs out, or you try to reopen a blocked website, ScrollGuard returns an existing tab to its previous page when possible and closes fresh tabs with no previous page. It sends a notification with the website nickname. After closing a tab, with notifications enabled, it also opens or focuses your Activity overview with a dismissible time-limit alert, where you can earn a break. Returning to a previous page keeps that tab focused and does not open or focus the overview. Repeated closures reuse the same overview tab. The explanation still appears if Windows hides the desktop notification. Desktop banners and sounds follow your Windows notification and Do not disturb settings.

[Microsoft's notification settings guide](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows)

## Update an existing installation

Keep the same installation folder and browser profile to preserve extension identity and locally stored settings. Replace the files in that folder with this download's contents, then click **Reload** on ScrollGuard's card in `chrome://extensions`. Reload previously open tracked websites too. Do not remove the installed extension first; removing it deletes its local data.

Daily limits reset at **6:00 AM local time**. See `README.md` for behavior, upgrade details, and limitations.
