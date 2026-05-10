// URL → context classifier.
//
// Why URL-only: Instagram obfuscates DOM class names (they look like ".x1lliihq")
// and rotates them frequently, so any selector-based detection rots fast.
// URL paths are the stable contract — they have to be, since IG itself routes
// on them. We trade some precision (we can't tell "reel inside a profile" from
// "reel from feed") for resilience.
//
// This file is loaded both as a content script AND via importScripts in the
// service worker, so it must work in both contexts. We attach to globalThis
// rather than using ES module exports.

function classifyContext(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'other';
  }

  // Order matters: check specific paths before the generic single-segment
  // profile fallback. A URL like /reels/123 has a single segment after splitting
  // out the leading slash, but it's clearly not a profile.
  if (path.includes('/reels/') || path.includes('/reel/')) return 'reels';
  if (path.includes('/stories/')) return 'stories';
  if (path.includes('/direct/')) return 'dm';
  if (path.includes('/explore/')) return 'explore';
  if (path === '/') return 'feed';

  // /username — single non-empty segment that didn't match anything specific.
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 1) return 'profile';

  return 'other';
}

// Expose to both content-script global scope and SW global scope.
if (typeof self !== 'undefined') {
  self.classifyContext = classifyContext;
}
