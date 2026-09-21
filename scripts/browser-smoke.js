/* Real MV3 smoke test in a disposable Chromium profile. Pass PLAYWRIGHT_MODULE when
 * using a bundled runtime; otherwise install playwright locally to run this script. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const C = require('../lib/config.js');
const E = require('../lib/engine.js');
(async () => {
  const profileRoot = path.join(root, '.test-profile');
  fs.mkdirSync(profileRoot, { recursive: true });
  // A reused profile can retain an old MV3 worker even when unpacked files change.
  const profile = fs.mkdtempSync(path.join(profileRoot, 'run-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const base = `chrome-extension://${id}`;
    await worker.evaluate(async () => { await queue; });
    await worker.evaluate(async data => { state = data; await configure(); await scanBrowser(); await commit(); }, E.fresh(Date.now()));
    // Record successful native notification API calls without replacing delivery.
    await worker.evaluate(() => {
      globalThis.__notificationEvents = [];
      globalThis.__notificationErrors = [];
      const nativeCreate = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = async (...args) => {
        let id;
        try { id = await nativeCreate(...args); }
        catch (error) { globalThis.__notificationErrors.push({ message: error.message, options: args.at(-1) }); throw error; }
        globalThis.__notificationEvents.push({ id, options: args.at(-1) });
        return id;
      };
    });
    const page = await context.newPage();
    await page.goto(`${base}/options/options.html#sites`);
    await page.getByRole('button', { name: '+ Add website', exact: true }).filter({ visible: true }).click();
    await page.locator('#site-domain').fill('tiktok.com');
    await page.locator('#site-name').fill('TikTok');
    await page.locator('#site-limit').fill('0.1');
    await page.locator('#save-site').click();
    await page.waitForFunction(() => !document.getElementById('site-dialog').open);
    assert.equal(await page.locator('#site-table tr').count(), 1);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#questions').fill('2');
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent === 'Saved.');
    assert.equal(await page.locator('#difficulty-cards .difficulty-option').count(), 4);
    assert.equal(await page.locator('#settings-form').getByText('No time limit.', { exact: false }).count(), 1);
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/settings.png'), fullPage: true });
    await context.route('https://www.tiktok.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Tracked fixture</title><h1>Tracked test website</h1>' }));
    const social = await context.newPage();
    const closed = social.waitForEvent('close', { timeout: 20000 });
    await social.goto('https://www.tiktok.com/').catch(() => {});
    await social.bringToFront().catch(() => {});
    await closed;
    await worker.evaluate(async () => { await queue; });
    const notifications = await worker.evaluate(() => globalThis.__notificationEvents);
    assert.equal(notifications.length, 1, JSON.stringify(await worker.evaluate(async () => ({ errors: globalThis.__notificationErrors, enabled: state.settings.notifications, permission: await chrome.notifications.getPermissionLevel() }))));
    assert.equal(notifications[0].options.title, 'ScrollGuard');
    assert.equal(notifications[0].options.message, "You've reached your time limit for TikTok");
    assert.ok(notifications[0].id);
    await page.bringToFront();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'Earn a break', exact: true }).waitFor();
    await page.screenshot({ path: path.join(root, 'test-results/overview.png'), fullPage: true });
    const challengePromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Earn a break', exact: true }).click();
    const challenge = await challengePromise;
    await challenge.locator('#problem').waitFor({ state: 'visible' });
    const question = await challenge.locator('#problem').textContent();
    await challenge.locator('#answer').fill('999999');
    await challenge.locator('#submit').click();
    await challenge.getByText('Incorrect. Try again.', { exact: false }).waitFor();
    assert.equal(await challenge.locator('#problem').textContent(), question);
    assert.equal(await challenge.locator('#progress-label').textContent(), '0 of 2 completed');
    await challenge.screenshot({ path: path.join(root, 'test-results/challenge.png'), fullPage: true });
    const answerFor = text => String(Function(`return (${text.replace(' = ?', '').replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-')})`)());
    await challenge.locator('#answer').fill(answerFor(question));
    await challenge.locator('#submit').click();
    await challenge.getByText('1 of 2 completed', { exact: true }).waitFor();
    await challenge.reload();
    await challenge.getByText('1 of 2 completed', { exact: true }).waitFor();
    const second = await challenge.locator('#problem').textContent();
    const reopenedPromise = context.waitForEvent('page');
    await challenge.locator('#answer').fill(answerFor(second));
    await challenge.locator('#submit').click();
    const reopened = await reopenedPromise;
    await challenge.getByText('Break active.', { exact: true }).waitFor();
    const saved = await worker.evaluate(() => state.usage['tiktok.com']);
    assert.equal(saved.breaks, 1);
    assert.equal(saved.baseMs, 6000);
    assert.ok(saved.breakUntil > Date.now());
    await page.bringToFront();
    const deadline = saved.breakUntil;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await worker.evaluate(() => state.usage['tiktok.com'].breakUntil), deadline);
    // Shorten only the isolated test fixture's deadline to exercise actual browser closure.
    const breakClosed = reopened.waitForEvent('close', { timeout: 10000 });
    await worker.evaluate(async () => { state.usage['tiktok.com'].breakUntil = Date.now() + 1500; await commit(); });
    await breakClosed;
    await worker.evaluate(async () => { await queue; });
    assert.equal(await worker.evaluate(() => globalThis.__notificationEvents.length), 2);
    const denied = await context.newPage();
    const deniedClosed = denied.waitForEvent('close', { timeout: 10000 });
    await denied.goto('https://www.tiktok.com/again').catch(() => {});
    await deniedClosed;
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 410, height: 650 });
    await popup.goto(`${base}/popup/popup.html`);
    await popup.getByRole('button', { name: 'Earn a break' }).waitFor();
    await popup.screenshot({ path: path.join(root, 'test-results/popup.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await worker.evaluate(async () => {
      for (const { id } of globalThis.__notificationEvents) await chrome.notifications.clear(id);
    });
    console.log('PASS: real MV3 startup, site setup, settings, active allowance, tab closure, native notification API, retry, challenge reload, grant, elapsed-clock deadline, expiry, reopening enforcement, and popup.');
  } finally {
    await context.close();
    const target = fs.realpathSync(profile), allowedRoot = fs.realpathSync(profileRoot);
    if (!target.startsWith(allowedRoot + path.sep)) throw new Error('Test profile is outside its expected directory.');
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
