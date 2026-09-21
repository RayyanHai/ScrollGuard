/* Grants and challenge completion are committed together in one state object. */
globalThis.SGStorage = {
  migrationNotice: 'Your website limits were imported. Previous history is preserved separately. Today’s usage starts at zero because the daily reset changed to 6:00 AM.',
  async load(now) {
    const data = await chrome.storage.local.get(['scrollguardV4', 'userConfig', 'dailyActive']);
    if (data.scrollguardV4?.version === 4) {
      if (data.scrollguardV4.notice) data.scrollguardV4.notice = this.migrationNotice;
      // Enable the requested closure notifications once for existing installs.
      // Subsequent user changes to the preference survive reloads.
      if (!data.scrollguardV4.closureNotificationsVersion) {
        data.scrollguardV4.settings.notifications = true;
        if (data.scrollguardV4.pending) data.scrollguardV4.pending.settings.notifications = true;
        for (const ch of Object.values(data.scrollguardV4.challenges || {})) {
          if (ch.proposal?.settings) ch.proposal.settings.notifications = true;
        }
        data.scrollguardV4.closureNotificationsVersion = 1;
      }
      return data.scrollguardV4;
    }
    const state = SGEngine.fresh(now);
    if (data.userConfig || data.dailyActive) {
      const old = data.userConfig || {};
      const limit = (old.dailyCeilingMs ?? old.limitMs ?? 60 * SG.MINUTE) / SG.MINUTE;
      state.sites = ['instagram.com', 'tiktok.com'].map(domain => SG.site({ domain,
        name: domain === 'instagram.com' ? 'Instagram' : 'TikTok',
        limitMinutes: limit || 60, mode: limit === 0 ? 'track' : 'limit', subdomains: true }));
      state.settings.questions = Math.max(1, Math.min(100, old.mathCount || 5));
      state.settings.maxQuestions = Math.max(25, state.settings.questions);
      state.settings.difficulty = ['easy', 'normal', 'hard'][Number(old.mathDifficulty || 2) - 1] || 'normal';
      state.notice = this.migrationNotice;
    }
    // Keep legacy keys for recovery; midnight totals cannot be relabelled as 6 AM totals.
    await this.save(state);
    return state;
  },
  async save(state) { await chrome.storage.local.set({ scrollguardV4: state }); },
};
