'use strict';
const $ = id => document.getElementById(id);
const challengeId = new URLSearchParams(location.search).get('id');
let current, name, busy = false;
function fail(error) {
  $('loading').hidden = $('task').hidden = $('success').hidden = true;
  $('failure').hidden = false;
  $('failure-copy').textContent = error.message;
}
function render(ch) {
  current = ch;
  $('loading').hidden = true;
  $('task').hidden = ch.done;
  $('success').hidden = !ch.done;
  if (ch.done) {
    const settings = ch.purpose === 'settings';
    const expired = !settings && ch.breakUntil <= Date.now();
    $('success-title').textContent = settings ? 'Settings updated.' : expired ? 'Break expired.' : 'Break active.';
    $('success-copy').textContent = settings ? 'Your changes are now active. No break was granted and your break count is unchanged.'
      : expired ? 'Return to ScrollGuard if you want to earn another break.' : `${name} is available until ${UI.time(ch.breakUntil)}. The clock keeps running, even if you switch away.`;
    $('open-site').hidden = settings || expired;
    return;
  }
  $('site-name').textContent = name;
  $('task-title').textContent = ch.purpose === 'settings' ? 'Confirm settings changes' : 'Math challenge';
  $('task-description').textContent = ch.purpose === 'settings' ? `Complete ${ch.questions} questions to apply your settings.` : `Complete ${ch.questions} questions for a ${UI.duration(ch.rewardMs)} break.`;
  $('progress-label').textContent = `${ch.completed} of ${ch.questions} completed`;
  $('difficulty-label').textContent = UI.difficulty(ch.difficulty);
  const percent = Math.round(ch.completed / ch.questions * 100);
  $('progress-fill').style.width = `${percent}%`;
  $('progress').setAttribute('aria-valuenow', percent);
  $('problem').textContent = `${ch.problem} = ?`;
  $('answer').value = '';
  $('answer').focus();
}
$('answer-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true; $('submit').disabled = true;
  try {
    const reply = await UI.request('ANSWER', { id: challengeId, index: current.completed, answer: $('answer').value.trim() });
    render(reply.challenge);
    $('feedback').className = `feedback${reply.correct || reply.stale ? '' : ' error'}`;
    $('feedback').textContent = reply.stale ? 'Progress updated from your other challenge tab.' : reply.correct ? 'Correct.' : 'Incorrect. Try again. Your progress is saved.';
  } catch (error) { fail(error); }
  finally { busy = false; $('submit').disabled = false; }
});
$('open-site').onclick = async () => {
  try { await UI.request('OPEN_SITE', { domain: current.site }); }
  catch (error) { fail(error); }
};
async function load() {
  try {
    const reply = await UI.request('GET_CHALLENGE', { id: challengeId });
    name = reply.name;
    if (reply.proposal) {
      $('proposal').hidden = false;
      $('proposal-content').replaceChildren(UI.el('p', { class: 'hint', text: `Math: ${UI.difficulty(reply.proposal.settings.difficulty)}, ${reply.proposal.settings.questions} questions. Breaks: ${reply.proposal.settings.breakMinutes} minutes. Settings protection: ${reply.proposal.settings.protection}.` }), ...reply.proposal.sites.map(s => UI.el('p', { class: 'hint', text: `${s.name}: ${s.limitMinutes} min daily · ${s.mode}` })));
    }
    render(reply.challenge);
  } catch (error) { fail(error); }
}
load();
// A completed break can expire while this success page remains open. No challenge timer.
setInterval(() => { if (current?.done) render(current); }, 1000);
