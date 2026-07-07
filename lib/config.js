// ScrollGuard configuration.
//
// Loaded in the SW via importScripts. The popup writes user overrides to
// `userConfig` in chrome.storage.local; the SW merges them on top of these
// defaults via the cfg() function.
//
// v3 (earn-to-scroll): the model is INVERTED. Tracked platforms are BLOCKED by
// default. The only way in is to pass a challenge that grants a fixed scrolling
// window (wall-clock). Two independent challenge paths:
//   - password  → grants passwordGrantMs
//   - math set  → solve mathCount problems at mathDifficulty → grants mathGrantMs
// Grants do NOT stack: each pass opens a fresh window. An optional per-platform
// daily ceiling (dailyCeilingMs) caps total ACTIVE scroll time per day; once
// hit, no more unlocks until midnight. All settings are GLOBAL (shared across
// platforms); per-platform state (daily counter, window) lives keyed by
// platform id at runtime.

self.SG_CONFIG = {
  passwordEnabled: true,
  password: null,                 // null = setup needed; popup forces a password on first run
  passwordGrantMs: 5 * 60_000,    // password unlock buys a 5 min scroll window

  mathEnabled: true,
  mathCount: 5,                   // problems per set
  mathDifficulty: 2,              // 1 | 2 | 3 (see SG_makeMathProblem)
  mathGrantMs: 10 * 60_000,       // solving a full set buys a 10 min scroll window

  dailyCeilingMs: 60 * 60_000,    // hard cap on active scroll time per day; 0 = no cap
};

// Tracked platforms. The hostSuffix is matched against URL hostname (exact
// host or any subdomain). `label` is the user-facing name used in overlay
// copy and dashboard headings. Order here determines popup display order.
self.SG_PLATFORMS = [
  { id: 'instagram', label: 'Instagram', hostSuffix: 'instagram.com' },
  { id: 'tiktok',    label: 'TikTok',    hostSuffix: 'tiktok.com'    },
];

// URL → platform id (or null if untracked). Centralized so SW + popup +
// tests agree on classification.
self.SG_platformForUrl = function (url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  for (const p of self.SG_PLATFORMS) {
    if (host === p.hostSuffix || host.endsWith('.' + p.hostSuffix)) return p.id;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Math challenge generation
// ---------------------------------------------------------------------------
//
// Pure, deterministic-per-call generators shared by the SW (which owns
// generation + validation) so problem rules live in exactly one place.
//
// Difficulty:
//   1 → addition only,                 operands 1–20
//   2 → addition + subtraction,        operands 1–50 (subtraction never negative)
//   3 → + multiplication,              add/sub 1–100, multiply 2–12
//
// A problem is { a, b, op, answer } where op is '+', '-', or '×'. The `answer`
// is included for the SW's own validation; it must be stripped before the
// problem is sent to a content script.

function sgRandInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

self.SG_makeMathProblem = function (difficulty) {
  const d = (difficulty === 1 || difficulty === 3) ? difficulty : 2;

  // Pick an operation available at this difficulty.
  const ops = d === 1 ? ['+'] : d === 2 ? ['+', '-'] : ['+', '-', '×'];
  const op = ops[sgRandInt(0, ops.length - 1)];

  if (op === '×') {
    const a = sgRandInt(2, 12);
    const b = sgRandInt(2, 12);
    return { a, b, op, answer: a * b };
  }

  const hi = d === 1 ? 20 : d === 2 ? 50 : 100;
  let a = sgRandInt(1, hi);
  let b = sgRandInt(1, hi);
  if (op === '-') {
    // Keep results non-negative: larger operand first.
    if (b > a) { const t = a; a = b; b = t; }
    return { a, b, op, answer: a - b };
  }
  return { a, b, op, answer: a + b };
};

self.SG_makeMathSet = function (count, difficulty) {
  const n = Math.max(1, Math.min(20, count | 0));
  const out = [];
  for (let i = 0; i < n; i++) out.push(self.SG_makeMathProblem(difficulty));
  return out;
};
