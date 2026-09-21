const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/config.js');
const E = require('../lib/engine.js');
const at = (day, time) => new Date(`2026-09-${day}T${time}:00`).getTime();
function fixture(now = at('16', '12:00')) {
  const state = E.fresh(now);
  state.sites.push(C.site({ domain: 'tiktok.com', limitMinutes: 5 }));
  return [state, state.sites[0]];
}
test('website parsing and matching use hostname boundaries and protocol', () => {
  assert.equal(C.domain('https://www.YouTube.com/shorts/abc'), 'youtube.com');
  const site = C.site({ domain: 'youtube.com', limitMinutes: 5 });
  assert.ok(C.matches(site, 'https://m.youtube.com/watch?v=1'));
  assert.ok(!C.matches(site, 'https://notyoutube.com'));
  assert.ok(!C.matches(site, 'https://youtube.com.evil.test'));
  assert.ok(!C.matches(site, 'file://youtube.com/a'));
  assert.throws(() => C.domain('chrome://extensions'));
  assert.throws(() => C.domain('https://user:password@example.com'));
  assert.throws(() => C.site({ domain: 'm.youtube.com', limitMinutes: 1 }, [site]), /overlaps/);
});
test('the usage day changes at 6 AM, never at midnight', () => {
  assert.equal(E.dayKey(at('16', '05:59')), '2026-09-15');
  assert.equal(E.dayKey(at('16', '06:00')), '2026-09-16');
  assert.equal(E.nextReset(at('16', '05:59')), at('16', '06:00'));
  assert.equal(E.nextReset(at('16', '06:00')), at('17', '06:00'));
});
test('allowance exhaustion caps charged use and blocks the website', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  E.charge(state, site.domain, now, now + 4 * C.MINUTE);
  assert.equal(E.status(state, site, now + 4 * C.MINUTE), 'available');
  E.charge(state, site.domain, now + 4 * C.MINUTE, now + 10 * C.MINUTE);
  assert.equal(E.status(state, site, now + 10 * C.MINUTE), 'blocked');
  assert.equal(E.usage(state, site.domain).baseMs, 5 * C.MINUTE);
  assert.equal(E.usage(state, site.domain).activeMs, 5 * C.MINUTE);
});
test('break deadlines run without activity and cannot stack', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  const u = E.usage(state, site.domain); u.baseMs = 5 * C.MINUTE;
  const ch = { day: state.day, revision: state.revision, rewardMs: 2 * C.MINUTE };
  state.settings.breakMinutes = 2;
  assert.equal(E.grant(state, site, ch, now), now + 2 * C.MINUTE);
  assert.equal(E.status(state, site, now + 119999), 'break');
  assert.equal(E.status(state, site, now + 120000), 'blocked');
  assert.match(E.terms(state, site, now + 1000).reason, /current allowance/);
  assert.equal(E.grant(state, site, ch, now + 2000), now + 2 * C.MINUTE);
  assert.equal(u.breaks, 1);
});
test('actual break usage is counted separately from the base allowance', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  const u = E.usage(state, site.domain); u.baseMs = 5 * C.MINUTE; u.activeMs = 5 * C.MINUTE;
  u.breakUntil = now + C.MINUTE;
  E.charge(state, site.domain, now, now + 90_000);
  assert.equal(u.activeMs, 6 * C.MINUTE);
  assert.equal(u.baseMs, 5 * C.MINUTE);
});
test('reset splits a session, archives yesterday, and clears grants and challenges', () => {
  const from = at('16', '05:59'), to = at('16', '06:01');
  const [state, site] = fixture(from);
  E.usage(state, site.domain).breaks = 3;
  state.challenges.a = { id: 'old' };
  E.charge(state, site.domain, from, to);
  assert.equal(state.day, '2026-09-16');
  assert.equal(state.history['2026-09-15'][site.domain].activeMs, C.MINUTE);
  assert.equal(state.usage[site.domain].activeMs, C.MINUTE);
  assert.equal(state.usage[site.domain].breaks, 0);
  assert.deepEqual(state.challenges, {});
});
test('a break awarded near reset is capped to the remaining day', () => {
  const now = at('16', '05:59'); const [state, site] = fixture(now);
  E.usage(state, site.domain).baseMs = 5 * C.MINUTE;
  state.settings.breakMinutes = 5;
  const terms = E.terms(state, site, now);
  assert.equal(terms.rewardMs, C.MINUTE);
  const ch = { day: state.day, revision: 0, rewardMs: terms.rewardMs };
  assert.equal(E.grant(state, site, ch, now), at('16', '06:00'));
});
test('daily grant caps and break count caps independently prevent more grants', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  const u = E.usage(state, site.domain); u.baseMs = 5 * C.MINUTE;
  state.settings.maxBreaks = 2; u.breaks = 2;
  assert.match(E.terms(state, site, now).reason, /break limit/);
  state.settings.maxBreaks = 0; state.settings.maxExtraMinutes = 2;
  u.grantedMs = 90_000; state.settings.breakMinutes = 2;
  assert.equal(E.terms(state, site, now).rewardMs, 30_000);
  u.grantedMs = 120_000;
  assert.match(E.terms(state, site, now).reason, /extra-time limit/);
});
test('all four math levels generate valid integer answers', () => {
  for (const difficulty of C.DIFFICULTIES) {
    for (let i = 0; i < 300; i++) {
      const p = E.problem(difficulty.id);
      assert.ok(Number.isInteger(p.answer));
      const expression = p.text.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');
      assert.equal(Function(`return (${expression})`)(), p.answer);
    }
  }
});
test('wrong answers always retry the same problem without losing correct progress', () => {
  const ch = { questions: 3, completed: 1, problems: [{ text: '1 + 1', answer: 2 }, { text: '2 + 3', answer: 5 }, { text: '3 + 3', answer: 6 }] };
  for (const answer of ['4', '', '5abc', '5.0', 'Infinity']) {
    assert.deepEqual(E.answer(ch, answer, 1), { correct: false });
    assert.equal(ch.completed, 1);
    assert.equal(ch.problems[1].text, '2 + 3');
  }
  assert.deepEqual(E.answer(ch, '5', 1), { correct: true, complete: false });
  assert.deepEqual(E.answer(ch, '5', 1), { correct: false, stale: true });
  assert.equal(ch.completed, 2);
  assert.deepEqual(E.answer(ch, '6', 2), { correct: true, complete: true });
});
test('public challenges never reveal answers or settings proposals', () => {
  const ch = { id: 'x', completed: 0, problems: [{ text: '2 + 3', answer: 5 }], proposal: { secret: true } };
  const out = E.publicChallenge(ch);
  assert.equal(out.problem, '2 + 3');
  assert.equal(out.problems, undefined);
  assert.equal(out.proposal, undefined);
});
test('escalation counts successful breaks, respects scope and caps', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  state.settings.escalation = true;
  E.usage(state, site.domain).breaks = 3;
  assert.equal(E.terms(state, site, now).questions, 11);
  assert.equal(E.terms(state, site, now).difficulty, 'hard');
  E.usage(state, 'other.test').breaks = 10;
  assert.equal(E.terms(state, site, now).questions, 11);
  state.settings.escalationScope = 'global';
  assert.equal(E.terms(state, site, now).questions, 25);
  assert.equal(E.terms(state, site, now).difficulty, 'extra-hard');
});
test('tracking-only and disabled sites have explicit behavior', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  site.mode = 'track'; E.charge(state, site.domain, now, now + 10 * C.MINUTE);
  assert.equal(E.usage(state, site.domain).activeMs, 10 * C.MINUTE);
  assert.equal(E.status(state, site, now), 'tracking');
  site.mode = 'off'; E.charge(state, site.domain, now, now + 10 * C.MINUTE);
  assert.equal(E.usage(state, site.domain).activeMs, 10 * C.MINUTE);
  assert.equal(E.status(state, site, now), 'off');
});
test('scheduled settings apply at reset and invalidate old challenges', () => {
  const now = at('16', '12:00'); const [state, site] = fixture(now);
  state.pending = { settings: { ...state.settings, questions: 8 }, sites: [{ ...site, limitMinutes: 20 }] };
  E.rollover(state, at('17', '06:00'));
  assert.equal(state.settings.questions, 8); assert.equal(state.sites[0].limitMinutes, 20);
  assert.equal(state.pending, null); assert.equal(state.revision, 1);
  assert.throws(() => E.grant(state, state.sites[0], { day: '2026-09-16', revision: 0 }, at('17', '06:00')), /changed/);
});
test('settings reject invalid durations and preserve the simple four-level model', () => {
  assert.throws(() => C.settings({ breakMinutes: 6 }));
  assert.throws(() => C.settings({ questions: 0 }));
  assert.throws(() => C.settings({ difficulty: 'quadratic' }));
  assert.equal(C.settings({ difficulty: 'extra-hard' }).difficulty, 'extra-hard');
  const site = C.site({ domain: 'example.com', limitMinutes: 0, overrides: { questions: 40 } });
  const [state] = fixture();
  assert.equal(C.effective(state, site).maxQuestions, 40);
  state.settings.escalation = true;
  assert.equal(C.effective(state, site).escalation, true);
});
