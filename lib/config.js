// ScrollGuard configuration.
//
// Loaded in the SW via importScripts. The popup writes user overrides to
// `userConfig` in chrome.storage.local; the SW merges them on top of these
// defaults via the cfg() function.
//
// v3 (TikTok support): the time/cooldown/grace/password settings are GLOBAL —
// shared across every tracked platform. Per-platform state (daily counter,
// block state, sessions) lives keyed by platform id at runtime.

self.SG_CONFIG = {
  limitMs: 30 * 60_000,         // active time per day on EACH platform before block
  blockCooldownMs: 30 * 60_000, // block lasts 30 min (per platform)
  passwordGraceMs: 5 * 60_000,  // password unlock buys 5 min before re-block
  password: null,                // null = setup needed; popup forces a password on first run
};

// Tracked platforms. The hostSuffix is matched against URL hostname (exact
// host or any subdomain). `label` is the user-facing name used in overlay
// copy and dashboard headings. Order here determines popup display order.
self.SG_PLATFORMS = [
  { id: 'instagram', label: 'Instagram', hostSuffix: 'instagram.com' },
  { id: 'tiktok',    label: 'TikTok',    hostSuffix: 'tiktok.com'    },
];

// URL → platform id (or null if untracked). Centralized so SW + popup +
// future tests agree on classification.
self.SG_platformForUrl = function (url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  for (const p of self.SG_PLATFORMS) {
    if (host === p.hostSuffix || host.endsWith('.' + p.hostSuffix)) return p.id;
  }
  return null;
};
