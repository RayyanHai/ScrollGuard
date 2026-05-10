// ScrollGuard configuration. The one file you edit to change the feel.
//
// Loaded in the SW via importScripts. Not loaded in content scripts — they
// receive the values they need (currently only `password` for verification,
// done via message-passing so the password hash never appears in the page).

self.SG_CONFIG = {
  // -------------------------------------------------------------------------
  // Limits — how long active time in a group can accumulate before we block.
  // Numbers are in milliseconds.
  // -------------------------------------------------------------------------
  limits: {
    scroll: 60_000,   // feed + stories combined
    reels:  30_000,
    other:  90_000,   // explore + profile + other
    // dm has no entry → never blocks
  },

  // Map IG context → limit-group key. A context with no entry never blocks.
  // Group keys must match keys in `limits` above.
  contextToGroup: {
    feed:    'scroll',
    stories: 'scroll',
    reels:   'reels',
    explore: 'other',
    profile: 'other',
    other:   'other',
    // dm: undefined → DMs are unblockable
  },

  // -------------------------------------------------------------------------
  // Block behavior
  // -------------------------------------------------------------------------

  // After the limit hits, the group stays blocked for this long. During this
  // window, navigating to any context in the group shows the block overlay.
  blockCooldownMs: 5 * 60_000,

  // When the user types the correct password, they get this much unlocked
  // time. After it expires, the block resumes for the remainder of its
  // cooldown. The cooldown clock does NOT pause during unlock — the unlock
  // eats into it. (If you want pause-on-unlock instead, tell me; it's a
  // one-line change in tickBlockState.)
  passwordGraceMs: 30_000,

  // -------------------------------------------------------------------------
  // Password
  // -------------------------------------------------------------------------
  // CHANGE THIS to whatever you want. Stored in plaintext because this is a
  // self-imposed friction layer, not a security boundary — anyone with
  // chrome://extensions devtools access can read it. The point is to make
  // bypass annoying enough that you reflect, not impossible.
  password: 'scrollguard-please',
};
