/* Daily accounting and challenges: pure functions, no browser dependencies. */
(function (root) {
  'use strict';
  const C = root.SG || require('./config.js');
  const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function dayKey(now) {
    const d = new Date(now);
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    return localDate(d);
  }
  function nextReset(now) {
    const d = new Date(now);
    d.setHours(6, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  function fresh(now = Date.now()) {
    return { version: 4, closureNotificationsVersion: 1, day: dayKey(now), settings: { ...C.DEFAULTS }, sites: [], usage: {},
      history: {}, challenges: {}, pending: null, revision: 0, notice: null };
  }
  function usage(state, id) {
    return state.usage[id] ||= { activeMs: 0, baseMs: 0, breaks: 0, grantedMs: 0, breakUntil: 0 };
  }
  function rollover(state, now) {
    const key = dayKey(now);
    if (state.day === key) return false;
    state.history[state.day] = structuredClone(state.usage);
    for (const old of Object.keys(state.history).sort().slice(0, -90)) delete state.history[old];
    state.day = key;
    state.usage = {};
    state.challenges = {};
    if (state.pending) {
      state.settings = state.pending.settings;
      state.sites = state.pending.sites;
      state.pending = null;
      state.revision++;
    }
    return true;
  }
  function status(state, site, now) {
    const u = usage(state, site.domain);
    if (site.mode === 'off') return 'off';
    if (site.mode === 'track') return 'tracking';
    if (u.breakUntil > now) return 'break';
    return u.baseMs >= site.limitMinutes * C.MINUTE ? 'blocked' : 'available';
  }
  function charge(state, id, from, to) {
    if (to <= from) { rollover(state, to); return; }
    let cursor = from;
    while (cursor < to) {
      rollover(state, cursor);
      const end = Math.min(to, nextReset(cursor));
      const site = state.sites.find(s => s.domain === id);
      if (site && site.mode !== 'off') {
        const u = usage(state, id);
        const breakMs = Math.max(0, Math.min(end, u.breakUntil) - cursor);
        const ordinary = end - cursor - breakMs;
        const base = site.mode === 'track' ? ordinary : Math.min(ordinary, Math.max(0, site.limitMinutes * C.MINUTE - u.baseMs));
        u.baseMs += base;
        u.activeMs += base + breakMs;
      }
      cursor = end;
    }
    rollover(state, to);
  }
  function terms(state, site, now) {
    const config = C.effective(state, site);
    const u = usage(state, site.domain);
    const earned = config.escalationScope === 'global'
      ? Object.values(state.usage).reduce((n, row) => n + row.breaks, 0) : u.breaks;
    const step = config.escalation ? earned : 0;
    const base = C.DIFFICULTIES.findIndex(d => d.id === config.difficulty);
    const level = Math.min(3, base + (config.difficultyEvery ? Math.floor(step / config.difficultyEvery) : 0));
    const rewardMs = Math.min(config.breakMinutes * C.MINUTE,
      config.maxExtraMinutes ? Math.max(0, config.maxExtraMinutes * C.MINUTE - u.grantedMs) : Infinity,
      nextReset(now) - now);
    let reason = null;
    if (!site.allowBreaks) reason = 'Earned breaks are turned off for this website.';
    else if (status(state, site, now) !== 'blocked') reason = 'Use the current allowance before earning another break.';
    else if (config.maxBreaks && u.breaks >= config.maxBreaks) reason = 'Your daily break limit is reached.';
    else if (rewardMs <= 0) reason = 'Your daily extra-time limit is reached.';
    return { questions: Math.min(config.maxQuestions, config.questions + step * config.questionStep),
      difficulty: C.DIFFICULTIES[level].id, rewardMs, reason };
  }
  function problem(difficulty, random = Math.random) {
    const int = (a, b) => a + Math.floor(random() * (b - a + 1));
    let a, b, answer, text;
    if (difficulty === 'easy') {
      a = int(1, 20); b = int(1, 20); answer = a + b; text = `${a} + ${b}`;
    } else if (difficulty === 'normal') {
      a = int(10, 99); b = int(1, 99);
      if (random() < .5) { answer = a + b; text = `${a} + ${b}`; }
      else { [a, b] = [Math.max(a, b), Math.min(a, b)]; answer = a - b; text = `${a} − ${b}`; }
    } else if (difficulty === 'hard') {
      a = int(2, 12); b = int(2, 12);
      if (random() < .5) { answer = a * b; text = `${a} × ${b}`; }
      else { answer = a; text = `${a * b} ÷ ${b}`; }
    } else {
      a = int(12, 25); b = int(3, 12); const c = int(10, 40);
      if (random() < .5) { answer = a * b + c; text = `(${a} × ${b}) + ${c}`; }
      else { answer = a * b - c; text = `(${a} × ${b}) − ${c}`; }
    }
    return { text, answer };
  }
  function publicChallenge(ch) {
    return { id: ch.id, day: ch.day, site: ch.site, purpose: ch.purpose, questions: ch.questions,
      difficulty: ch.difficulty, rewardMs: ch.rewardMs, completed: ch.completed,
      problem: ch.problems[ch.completed]?.text, done: !!ch.done, breakUntil: ch.breakUntil || 0 };
  }
  function answer(ch, input, index) {
    if (ch.done || index !== ch.completed) return { correct: false, stale: true };
    if (typeof input !== 'string' || !/^-?\d+$/.test(input.trim()) || Number(input) !== ch.problems[ch.completed].answer) return { correct: false };
    ch.completed++;
    return { correct: true, complete: ch.completed === ch.questions };
  }
  function grant(state, site, ch, now) {
    if (ch.done) return ch.breakUntil;
    if (ch.day !== dayKey(now) || ch.revision !== state.revision) throw new Error('Your settings or daily allowance changed. Start a new challenge.');
    const t = terms(state, site, now);
    if (t.reason) throw new Error(t.reason);
    const u = usage(state, site.domain);
    const duration = Math.min(ch.rewardMs, t.rewardMs);
    u.breakUntil = now + duration;
    u.grantedMs += duration;
    u.breaks++;
    ch.done = true;
    ch.breakUntil = u.breakUntil;
    return u.breakUntil;
  }
  const api = { dayKey, nextReset, fresh, usage, rollover, status, charge, terms, problem, publicChallenge, answer, grant };
  root.SGEngine = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
