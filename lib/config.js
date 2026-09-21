/* Shared policy and input validation. No browser dependencies. */
(function (root) {
  'use strict';
  const MINUTE = 60_000;
  const DEFAULTS = Object.freeze({
    difficulty: 'normal', questions: 5, breakMinutes: 1, maxBreaks: 0, maxExtraMinutes: 0,
    escalation: false, escalationScope: 'site', questionStep: 2, difficultyEvery: 3, maxQuestions: 25,
    pauseIdle: false, idleSeconds: 120, autoReopen: true, notifications: true, badge: true,
    protection: 'immediate',
  });
  const DIFFICULTIES = [
    { id: 'easy', label: 'Easy', detail: 'Small-number addition', example: '8 + 6 = ?', answer: '14' },
    { id: 'normal', label: 'Normal', detail: 'Addition and subtraction', example: '47 − 19 = ?', answer: '28' },
    { id: 'hard', label: 'Hard', detail: 'Multiplication and exact division', example: '84 ÷ 7 = ?', answer: '12' },
    { id: 'extra-hard', label: 'Extra Hard', detail: 'Two-step arithmetic', example: '(18 × 7) − 24 = ?', answer: '102' },
  ];
  function domain(value) {
    const raw = String(value || '').trim();
    if (!raw || /[\s*]/.test(raw)) throw new Error('Enter a website such as youtube.com.');
    let url;
    try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
    catch { throw new Error('Enter a valid website address.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) {
      throw new Error('Use an ordinary http or https website domain.');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (!/^[a-z0-9.-]+$/.test(host) || host.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-'))) {
      throw new Error('Enter a valid website domain.');
    }
    return host;
  }
  function matches(site, url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      return host === site.domain || (site.subdomains && host.endsWith(`.${site.domain}`));
    } catch { return false; }
  }
  function origins(site) { return [`*://${site.subdomains ? '*.' : ''}${site.domain}/*`]; }
  function number(value, min, max, label, integer = true) {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new Error(`${label} must be ${min}–${max}${integer ? ' (a whole number)' : ''}.`);
    }
    return n;
  }
  function settings(input) {
    const s = { ...DEFAULTS, ...input };
    if (!DIFFICULTIES.some(d => d.id === s.difficulty)) throw new Error('Choose a difficulty.');
    for (const [key, lo, hi, label] of [
      ['questions', 1, 100, 'Questions'], ['breakMinutes', 1, 5, 'Break length'],
      ['maxBreaks', 0, 100, 'Daily breaks'], ['maxExtraMinutes', 0, 500, 'Daily extra minutes'],
      ['questionStep', 0, 20, 'Additional questions'], ['difficultyEvery', 0, 20, 'Difficulty interval'],
      ['maxQuestions', 1, 100, 'Maximum questions'], ['idleSeconds', 15, 3600, 'Idle threshold'],
    ]) s[key] = number(s[key], lo, hi, label);
    if (s.maxQuestions < s.questions) throw new Error('Maximum questions cannot be below the starting question count.');
    if (!['site', 'global'].includes(s.escalationScope)) throw new Error('Choose an escalation scope.');
    if (!['immediate', 'challenge', 'next-reset'].includes(s.protection)) throw new Error('Choose a settings protection mode.');
    for (const key of ['escalation', 'pauseIdle', 'autoReopen', 'notifications', 'badge']) s[key] = !!s[key];
    return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, s[k]]));
  }
  function site(input, existing = []) {
    const id = domain(input.domain);
    const s = { domain: id, name: String(input.name || id).trim().slice(0, 60) || id,
      subdomains: input.subdomains !== false, mode: input.mode || 'limit',
      limitMinutes: number(input.limitMinutes, 0, 1440, 'Daily allowance', false),
      allowBreaks: input.allowBreaks !== false, overrides: null };
    if (input.overrides) {
      const validated = settings({ ...input.overrides, maxQuestions: Math.max(25, Number(input.overrides.questions) || 5) });
      s.overrides = Object.fromEntries(['difficulty', 'questions', 'breakMinutes', 'maxBreaks', 'maxExtraMinutes'].map(k => [k, validated[k]]));
    }
    if (!['limit', 'track', 'off'].includes(s.mode)) throw new Error('Choose a website mode.');
    for (const other of existing) {
      if (other.domain === id) continue;
      if ((other.subdomains && id.endsWith(`.${other.domain}`)) || (s.subdomains && other.domain.endsWith(`.${id}`))) {
        throw new Error(`This overlaps with ${other.domain}. Edit that rule first.`);
      }
    }
    return s;
  }
  function effective(state, s) {
    return s.overrides ? { ...state.settings, ...s.overrides,
      maxQuestions: Math.max(state.settings.maxQuestions, s.overrides.questions) } : state.settings;
  }
  const api = { MINUTE, DEFAULTS, DIFFICULTIES, domain, matches, origins, settings, site, effective };
  root.SG = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
