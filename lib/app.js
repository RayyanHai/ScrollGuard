'use strict';
const { el, request, duration, time } = UI;
const $ = id => document.getElementById(id);
const compact = document.body.classList.contains('compact');
let snapshot, currentView = 'overview', editingDomain = null, refreshing = false;
let toastTimer, settingsDirty = false;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
async function run(action) {
  try { return await action(); }
  catch (error) { toast(error.message, true); return null; }
}
function difficultyCards(name, value) {
  return SG.DIFFICULTIES.map(d => el('label', { class: 'difficulty-option' }, [
    el('input', { type: 'radio', name, value: d.id, checked: d.id === value }),
    el('strong', { text: d.label }), el('span', { class: 'example', text: d.example }),
    el('span', { class: 'hint', text: d.detail }),
  ]));
}
function build() {
  $('app').innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="#overview"><img src="../icons/icon-192.png" alt="">ScrollGuard</a><span class="reset">Resets Daily at 6:00 AM</span></header>
      <nav class="nav" aria-label="Main navigation"><button data-view="overview">Overview</button><button data-view="sites">Manage websites</button><button data-view="settings">Settings</button></nav>
      <div id="notice" class="banner" hidden></div><div id="pending" class="banner" hidden></div>
      <main>
        <section id="view-overview">
          <div class="page-head"><div><h1>Activity overview</h1><p class="muted" id="day-label">Loading usage…</p></div><button id="overview-add" class="primary">+ Add website</button></div>
          <div class="stats" id="stats"></div>
          <div id="site-cards"></div>
          <div id="chart-panel" class="panel" hidden><div class="panel-head"><div><h2>Time spent</h2><p class="hint">Active website use, including earned breaks</p></div><select id="history-day" class="history-select" aria-label="Usage day"></select></div><div id="chart"></div><p class="hint">Each day runs from 6 AM to 6 AM. History stays on this device.</p></div>
        </section>
        <section id="view-sites" hidden>
          <div class="page-head"><div><h1>Manage websites</h1><p class="muted">Add websites and set daily limits.</p></div><button id="add-site" class="primary">+ Add website</button></div>
          <div class="panel"><div class="table-wrap"><table><thead><tr><th>Website</th><th>Daily allowance</th><th>Mode</th><th>Today</th><th>Actions</th></tr></thead><tbody id="site-table"></tbody></table></div><p id="no-sites" class="muted" hidden>No websites yet. Add your first website to start tracking.</p></div>
          <p class="hint">One allowance per website, shared across tabs. Removing a rule does not erase today's usage.</p>
        </section>
        <section id="view-settings" hidden>
          <div class="page-head"><div><h1>Settings</h1><p class="muted">Defaults for all websites. Individual websites can override math and break settings.</p></div></div>
          <form id="settings-form">
            <section class="panel settings-panel"><h2>Math challenges</h2><p>Complete the questions to earn a break. No time limit. Wrong answers are always retriable.</p><div id="difficulty-cards" class="difficulty-grid"></div>
              <label class="field"><span>Number of questions</span><input id="questions" type="number" min="1" max="100" required><span class="hint">Correct answers keep your progress. A mistake never takes it away.</span></label>
            </section>
            <section class="panel settings-panel"><h2>Earned breaks</h2><p>Breaks use clock time, even when you switch away or close the website.</p><div class="form-grid">
              <label class="field"><span>Minutes per break</span><input id="breakMinutes" type="number" min="1" max="5" required><span class="hint">Between 1 and 5 minutes.</span></label>
              <label class="field"><span>Maximum breaks per website per day</span><input id="maxBreaks" type="number" min="0" max="100" required><span class="hint">0 means unlimited.</span></label>
              <label class="field"><span>Maximum extra minutes per website per day</span><input id="maxExtraMinutes" type="number" min="0" max="500" required><span class="hint">Time granted, whether or not you use it. 0 means unlimited.</span></label>
            </div><label class="check"><input id="autoReopen" type="checkbox">Reopen the website when a challenge is completed</label><p class="hint">Breaks start on completion, cannot stack, and end at the next 6 AM reset at the latest.</p></section>
            <section class="panel settings-panel"><h2>Repeated breaks</h2><p>Optionally make later breaks harder to earn. Only completed challenges advance the count.</p>
              <label class="check"><input id="escalation" type="checkbox">Increase the challenge for later breaks</label>
              <div id="escalation-fields" class="form-grid">
                <label class="field"><span>Count earned breaks</span><select id="escalationScope"><option value="site">Separately for each website</option><option value="global">Across all websites</option></select></label>
                <label class="field"><span>Additional questions per earned break</span><input id="questionStep" type="number" min="0" max="20" required></label>
                <label class="field"><span>Increase difficulty every… earned breaks</span><input id="difficultyEvery" type="number" min="0" max="20" required><span class="hint">0 keeps the same difficulty. Never goes beyond Extra Hard.</span></label>
                <label class="field"><span>Maximum questions</span><input id="maxQuestions" type="number" min="1" max="100" required></label>
              </div><p class="hint">The count resets at 6 AM. Wrong answers and abandoned attempts do not increase it.</p>
            </section>
            <section class="panel settings-panel"><h2>Tracking & daily reset</h2><p>Only the selected website tab in your focused browser window uses the daily allowance.</p>
              <label class="check"><input id="pauseIdle" type="checkbox">Pause daily usage when I'm idle</label>
              <label class="field"><span>Idle threshold in seconds</span><input id="idleSeconds" type="number" min="15" max="3600" required><span class="hint">Watching without moving the mouse can count as idle. Earned breaks never pause.</span></label>
              <div class="banner"><span><strong>Daily reset: 6:00 AM</strong><br><span id="timezone"></span></span></div>
            </section>
            <section class="panel settings-panel"><h2>Preferences</h2><label class="check"><input id="notifications" type="checkbox">Notify me when ScrollGuard closes a website</label><label class="check"><input id="badge" type="checkbox">Show remaining minutes or break status on the toolbar icon</label>
              <label class="field"><span>Changes to settings and existing website rules</span><select id="protection"><option value="immediate">Apply immediately</option><option value="challenge">Complete a math challenge to apply changes</option><option value="next-reset">Apply at the next 6 AM reset</option></select><span class="hint">Protection covers edits and removals, including changes to protection itself. A new website can be added immediately.</span></label>
            </section>
            <div class="actions settings-actions"><span class="hint" id="settings-status"></span><button type="submit" class="primary" id="save-settings">Save settings</button></div>
          </form>
        </section>
      </main>
      <footer class="footer" id="popup-footer" hidden><button id="open-manage" class="quiet">Manage websites</button><button id="open-settings" class="quiet">Settings ↗</button></footer>
    </div>
    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    <dialog id="site-dialog"><form id="site-form"><div class="dialog-head"><h2 id="site-dialog-title">Add a website</h2><button type="button" id="close-dialog" class="quiet" aria-label="Close">✕</button></div>
      <div class="form-grid"><label class="field full"><span>Website</span><input id="site-domain" placeholder="youtube.com" required><span class="hint">Enter a domain or paste a website URL.</span></label><button type="button" id="current-site" class="small full">Use current website</button>
      <label class="field"><span>Nickname</span><input id="site-name" placeholder="Optional" maxlength="60"></label><label class="field"><span>Daily allowance in minutes</span><input id="site-limit" type="number" min="0" max="1440" step="0.1" required><span class="hint">0 means earn a break before visiting.</span></label>
      <label class="field full"><span>Mode</span><select id="site-mode"><option value="limit">Limit and close</option><option value="track">Track only</option><option value="off">Off</option></select></label></div>
      <label class="check"><input id="site-subdomains" type="checkbox">Include subdomains (such as www and m)</label><label class="check"><input id="site-breaks" type="checkbox">Allow earned breaks</label>
      <details id="site-custom"><summary>Math & break overrides</summary><label class="check"><input id="site-override" type="checkbox">Use custom settings for this website</label>
        <div id="override-fields"><div id="site-difficulties" class="difficulty-grid"></div><div class="form-grid">
          <label class="field"><span>Number of questions</span><input id="site-questions" type="number" min="1" max="100"></label><label class="field"><span>Minutes per break</span><input id="site-breakMinutes" type="number" min="1" max="5"></label>
          <label class="field"><span>Maximum breaks per day</span><input id="site-maxBreaks" type="number" min="0" max="100"><span class="hint">0 means unlimited.</span></label><label class="field"><span>Maximum extra minutes per day</span><input id="site-maxExtraMinutes" type="number" min="0" max="500"><span class="hint">0 means unlimited.</span></label>
        </div></div></details>
      <p id="site-error" class="error hint" role="alert"></p><div class="actions"><button type="button" id="cancel-site">Cancel</button><button type="submit" class="primary" id="save-site">Add website</button></div>
    </form></dialog>`;
  if (compact) {
    document.querySelector('.nav').hidden = true;
    $('stats').hidden = true;
    $('overview-add').hidden = true;
    $('popup-footer').hidden = false;
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.view; }));
  window.addEventListener('hashchange', navigate);
  $('overview-add').onclick = () => openSite();
  $('add-site').onclick = () => openSite();
  $('open-manage').onclick = () => UI.page('sites');
  $('open-settings').onclick = () => UI.page('settings');
  $('close-dialog').onclick = $('cancel-site').onclick = () => $('site-dialog').close();
  $('site-override').onchange = () => { $('override-fields').hidden = !$('site-override').checked; };
  $('escalation').onchange = () => { $('escalation-fields').hidden = !$('escalation').checked; };
  $('settings-form').addEventListener('input', () => { settingsDirty = true; $('settings-status').textContent = 'Unsaved changes'; });
  $('settings-form').addEventListener('change', () => { settingsDirty = true; $('settings-status').textContent = 'Unsaved changes'; });
  $('settings-form').addEventListener('submit', saveSettings);
  $('site-form').addEventListener('submit', saveSite);
  $('current-site').onclick = () => run(async () => {
    const tabList = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let tab = tabList.find(t => /^https?:/.test(t.url));
    if (!tab) tab = (await chrome.tabs.query({})).filter(t => /^https?:/.test(t.url)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!tab) throw new Error('Open a website tab first, or enter its address.');
    $('site-domain').value = SG.domain(tab.url);
  });
  $('history-day').onchange = renderChart;
}
function navigate() {
  const wanted = location.hash.slice(1);
  currentView = compact ? 'overview' : ['overview', 'sites', 'settings'].includes(wanted) ? wanted : 'overview';
  for (const view of ['overview', 'sites', 'settings']) $('view-' + view).hidden = currentView !== view;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current', button.dataset.view === currentView ? 'page' : 'false'));
  if (snapshot) {
    if (currentView === 'settings' && !settingsDirty) populateSettings();
    render();
  }
}
function emptyCard() {
  return el('div', { class: 'empty' }, [el('div', { class: 'empty-icon', text: '◷' }),
    el('h2', { text: 'No websites added' }),
    el('p', { text: 'Add a website and set a daily limit. Its tabs close when the limit is reached. Complete math problems to unlock a break.' }),
    el('button', { class: 'primary', text: '+ Add your first website', onclick: () => compact ? UI.page('sites') : openSite() })]);
}
function render() {
  $('day-label').textContent = `Today · ${snapshot.day} · resets at 6 AM`;
  $('notice').hidden = !snapshot.notice;
  if (snapshot.notice) $('notice').replaceChildren(el('span', { text: snapshot.notice }), el('button', { class: 'small', text: 'Dismiss', onclick: () => run(async () => { await request('DISMISS_NOTICE'); await refresh(); }) }));
  $('pending').hidden = !snapshot.pending;
  if (snapshot.pending) $('pending').replaceChildren(el('span', { text: 'Changes are scheduled for the next 6 AM reset. Current rules stay active until then.' }), el('button', { class: 'small', text: 'Cancel changes', onclick: () => run(async () => { await request('CANCEL_PENDING'); settingsDirty = false; await refresh(); populateSettings(); }) }));
  const total = snapshot.sites.reduce((n, s) => n + s.usage.activeMs, 0);
  const count = snapshot.sites.filter(s => s.status === 'blocked').length;
  const breaks = snapshot.sites.reduce((n, s) => n + s.usage.breaks, 0);
  $('stats').replaceChildren(...[[duration(total), 'Active time today'], [String(count), 'Websites at their limit'], [String(breaks), 'Breaks earned']].map(([value, label]) => el('div', { class: 'stat' }, [el('span', { text: label }), el('strong', { text: value })])));
  $('site-cards').replaceChildren(...(snapshot.sites.length ? snapshot.sites.map(siteCard) : [emptyCard()]));
  if (!$('site-dialog').open) renderTable();
  if (!compact) {
    $('chart-panel').hidden = !snapshot.sites.length && !Object.keys(snapshot.history).length;
    const selected = $('history-day').value;
    const keys = [snapshot.day, ...Object.keys(snapshot.history).sort().reverse()];
    $('history-day').replaceChildren(...keys.map(day => el('option', { value: day, text: day === snapshot.day ? 'Today (6 AM–6 AM)' : day })));
    if (keys.includes(selected)) $('history-day').value = selected;
    renderChart();
  }
}
function siteCard(site) {
  const kind = site.status, u = site.usage;
  const labels = { available: 'Available', blocked: 'Limit reached', break: 'Break active', tracking: 'Tracking only', off: 'Off' };
  const top = el('div', { class: 'site-top' }, [el('div', { class: 'site-identity' }, [el('div', { class: 'site-icon', text: site.name.slice(0, 1).toUpperCase() }), el('div', {}, [el('div', { class: 'site-name', text: site.name }), el('div', { class: 'site-domain', text: site.domain })])]), el('span', { class: `pill ${kind}`, text: labels[kind] })]);
  const card = el('article', { class: 'site-card', 'aria-label': site.name }, [top]);
  const remaining = Math.max(0, site.limitMinutes * SG.MINUTE - u.baseMs);
  card.append(el('div', { class: 'usage-line' }, [el('span', {}, [el('strong', { text: duration(u.activeMs) }), ' active today']), el('span', { text: kind === 'tracking' || kind === 'off' ? 'No daily limit enforced' : `${site.limitMinutes} min daily allowance` })]));
  if (site.mode === 'limit') card.append(el('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.round(u.baseMs / (site.limitMinutes * SG.MINUTE || 1) * 100)), 'aria-label': `${site.name} daily allowance used` }, [el('div', { class: 'meter-fill', style: `width:${site.limitMinutes ? Math.min(100, u.baseMs / (site.limitMinutes * SG.MINUTE) * 100) : 100}%` })]));
  const bottom = el('div', { class: 'site-bottom' });
  if (!site.access && site.mode !== 'off') {
    bottom.append(el('p', { class: 'error', text: 'Website access is needed to track time.' }), el('button', { class: 'small', text: 'Enable access', onclick: () => run(async () => {
      if (!await chrome.permissions.request({ origins: SG.origins(site) })) throw new Error('Website access was not granted.');
      await request('REFRESH_ACCESS'); await refresh();
    }) }));
  } else if (kind === 'blocked') {
    bottom.append(el('p', { text: site.terms.reason || `${site.terms.questions} ${UI.difficulty(site.terms.difficulty).toLowerCase()} questions → ${duration(site.terms.rewardMs)} break` }));
    if (!site.terms.reason) bottom.append(el('button', { class: 'primary small', text: 'Earn a break', onclick: event => run(async () => {
      event.currentTarget.disabled = true;
      await request('START_CHALLENGE', { domain: site.domain });
    }) }));
  } else if (kind === 'break') {
    bottom.append(el('p', { text: `Available until ${time(u.breakUntil)} · clock time` }), el('button', { class: 'small', text: 'Open website', onclick: () => run(() => request('OPEN_SITE', { domain: site.domain })) }));
  } else bottom.append(el('p', { text: kind === 'available' ? `${duration(remaining)} remaining · ${u.breaks} breaks earned today` : kind === 'off' ? 'Tracking and closure are turned off.' : 'Usage is recorded without closing tabs.' }));
  card.append(bottom);
  return card;
}
function renderTable() {
  const sites = snapshot.pending?.sites || snapshot.sites;
  $('no-sites').hidden = sites.length > 0;
  $('site-table').replaceChildren(...sites.map(site => {
    const live = snapshot.sites.find(s => s.domain === site.domain);
    return el('tr', {}, [el('td', {}, [el('strong', { text: site.name }), el('div', { class: 'site-domain', text: site.domain })]),
      el('td', { text: `${site.limitMinutes} min` }), el('td', { text: { limit: 'Limit and close', track: 'Track only', off: 'Off' }[site.mode] }),
      el('td', { text: duration(live?.usage.activeMs || 0) }), el('td', {}, [el('button', { class: 'small', text: 'Edit', onclick: () => openSite(site) }), ' ', el('button', { class: 'small quiet danger', text: 'Remove', onclick: () => {
        if (confirm(`Remove the rule for ${site.domain}? Recorded usage is kept.`)) run(async () => { const result = await request('REMOVE_SITE', { domain: site.domain }); toast(result.message); await refresh(); });
      } })])]);
  }));
}
function renderChart() {
  const day = $('history-day').value || snapshot.day;
  const rows = day === snapshot.day ? snapshot.sites.map(s => [s.domain, s.usage]) : Object.entries(snapshot.history[day] || {});
  const max = Math.max(1, ...rows.map(([, u]) => u.activeMs));
  $('chart').replaceChildren(...rows.sort((a, b) => b[1].activeMs - a[1].activeMs).map(([domain, u]) => el('div', { class: 'chart-row' }, [el('span', { class: 'chart-label', text: snapshot.sites.find(s => s.domain === domain)?.name || domain }), el('div', {}, [el('div', { class: 'bar', style: `width:${u.activeMs / max * 100}%` })]), el('span', { class: 'chart-value', text: duration(u.activeMs) })])));
}
function populateSettings() {
  const s = snapshot.pending?.settings || snapshot.settings;
  $('difficulty-cards').replaceChildren(...difficultyCards('difficulty', s.difficulty));
  for (const [key, value] of Object.entries(s)) {
    if (key === 'difficulty' || !$(key)) continue;
    if (typeof value === 'boolean') $(key).checked = value; else $(key).value = value;
  }
  $('escalation-fields').hidden = !s.escalation;
  $('timezone').textContent = `${Intl.DateTimeFormat().resolvedOptions().timeZone} · your computer's local timezone`;
  $('settings-status').textContent = snapshot.pending ? 'Editing scheduled settings' : '';
}
async function saveSettings(event) {
  event.preventDefault();
  $('save-settings').disabled = true;
  await run(async () => {
    const settings = {};
    for (const [key, value] of Object.entries(SG.DEFAULTS)) {
      settings[key] = key === 'difficulty' ? document.querySelector('input[name="difficulty"]:checked').value
        : typeof value === 'boolean' ? $(key).checked : typeof value === 'number' ? Number($(key).value) : $(key).value;
    }
    if (!settings.escalation) settings.maxQuestions = Math.max(settings.questions, settings.maxQuestions);
    const result = await request('SAVE_SETTINGS', { settings: SG.settings(settings) });
    toast(result.message); settingsDirty = false; await refresh(); populateSettings();
  });
  $('save-settings').disabled = false;
}
function openSite(site = null) {
  if (compact) { UI.page('sites'); return; }
  editingDomain = site?.domain || null;
  $('site-dialog-title').textContent = site ? 'Edit website' : 'Add a website';
  $('save-site').textContent = site ? 'Save website' : 'Add website';
  $('site-domain').value = site?.domain || ''; $('site-domain').readOnly = !!site;
  $('site-name').value = site?.name || ''; $('site-limit').value = site?.limitMinutes ?? 5;
  $('site-subdomains').checked = site?.subdomains ?? true; $('site-breaks').checked = site?.allowBreaks ?? true;
  $('site-mode').value = site?.mode || 'limit'; $('site-override').checked = !!site?.overrides;
  $('current-site').hidden = !!site;
  const config = { ...(snapshot.pending?.settings || snapshot.settings), ...site?.overrides };
  $('site-difficulties').replaceChildren(...difficultyCards('site-difficulty', config.difficulty));
  for (const key of ['questions', 'breakMinutes', 'maxBreaks', 'maxExtraMinutes']) $('site-' + key).value = config[key];
  $('override-fields').hidden = !site?.overrides; $('site-custom').open = !!site?.overrides;
  $('site-error').textContent = '';
  $('site-dialog').showModal();
  $('site-domain').focus();
}
async function saveSite(event) {
  event.preventDefault();
  $('save-site').disabled = true;
  $('site-error').textContent = '';
  try {
    let overrides = null;
    if ($('site-override').checked) {
      overrides = { difficulty: document.querySelector('input[name="site-difficulty"]:checked').value };
      for (const key of ['questions', 'breakMinutes', 'maxBreaks', 'maxExtraMinutes']) overrides[key] = Number($('site-' + key).value);
    }
    const site = SG.site({ domain: $('site-domain').value, name: $('site-name').value,
      limitMinutes: $('site-limit').value, mode: $('site-mode').value, subdomains: $('site-subdomains').checked,
      allowBreaks: $('site-breaks').checked, overrides }, snapshot.pending?.sites || snapshot.sites);
    // Called directly in the user's submit gesture, before any message round trip.
    if (!await chrome.permissions.request({ origins: SG.origins(site) })) throw new Error('Website access was not granted. The rule has not been saved.');
    const result = await request('SAVE_SITE', { site, editing: !!editingDomain });
    $('site-dialog').close(); toast(result.message); await refresh();
  } catch (error) { $('site-error').textContent = error.message; }
  finally { $('save-site').disabled = false; }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { snapshot = await request('GET_STATE'); render(); }
  finally { refreshing = false; }
}
build();
run(async () => { await refresh(); populateSettings(); navigate(); });
setInterval(() => { if (!document.hidden) run(refresh); }, 1500);
