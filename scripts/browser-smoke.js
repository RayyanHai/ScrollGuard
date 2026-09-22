/* Real MV3 smoke test in a disposable Chromium profile. Pass PLAYWRIGHT_MODULE when
 * using a bundled runtime; otherwise install playwright locally to run this script. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const E = require('../lib/engine.js');
(async () => {
  const profileRoot = path.join(root, '.test-profile');
  fs.mkdirSync(profileRoot, { recursive: true });
  // A reused profile can retain an old MV3 worker even when unpacked files change.
  const profile = fs.mkdtempSync(path.join(profileRoot, 'run-'));
  let context;
  const errors = [];
  const bounded = async (promise, description) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after 15s: ${description}`)), 15000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const launch = async wakeUrl => {
    context = await chromium.launchPersistentContext(profile, {
      headless: process.env.HEADED !== '1', channel: 'chromium', viewport: { width: 1280, height: 1000 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    });
    context.setDefaultTimeout(15000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https:\/\/(?:www\.)?tiktok\.com\//, route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Tracked fixture</title><h1>Tracked test website</h1>',
    }));
    if (wakeUrl) {
      // Wake the restored extension through its UI before attaching to its MV3
      // execution context. Chromium may expose a dormant worker target first.
      const wakePage = await context.newPage();
      await wakePage.goto(wakeUrl);
      await wakePage.getByRole('button', { name: 'Earn a break' }).waitFor();
      return wakePage;
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await bounded(worker.evaluate(() => true), 'worker execution context');
    await bounded(worker.evaluate(async () => { await queue; }), 'worker initialization');
    return worker;
  };
  const expectBlockedVisit = async url => {
    const tab = await context.newPage();
    const closed = tab.waitForEvent('close', { timeout: 10000 });
    await tab.goto(url).catch(error => { if (!tab.isClosed() && !/closed|ERR_ABORTED/.test(error.message)) throw error; });
    await closed;
  };
  try {
    let worker = await launch();
    const browserVersion = context.browser().version();
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
    const social = await context.newPage();
    const closed = social.waitForEvent('close', { timeout: 20000 });
    await social.goto('https://www.tiktok.com/').catch(() => {});
    await social.bringToFront().catch(() => {});
    // Reject exactly one heartbeat in the extension's actual isolated world.
    // A transient transport error must not disable the content script forever.
    assert.equal(await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => new Promise(resolve => {
        const nativeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        const deadline = setTimeout(() => { chrome.runtime.sendMessage = nativeSend; resolve(false); }, 5000);
        chrome.runtime.sendMessage = (...args) => {
          if (args[0]?.type !== 'PULSE') return nativeSend(...args);
          clearTimeout(deadline);
          chrome.runtime.sendMessage = nativeSend;
          resolve(true);
          return Promise.reject(new Error('Smoke-test transient messaging failure'));
        };
      }) });
      return injection.result;
    }), true, 'The isolated-world heartbeat failure must actually be exercised.');
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
    await expectBlockedVisit('https://www.tiktok.com/again');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 410, height: 650 });
    await popup.goto(`${base}/popup/popup.html`);
    await popup.getByRole('button', { name: 'Earn a break' }).waitFor();
    await popup.screenshot({ path: path.join(root, 'test-results/popup.png'), fullPage: true });
    await worker.evaluate(async () => {
      for (const { id } of globalThis.__notificationEvents) await chrome.notifications.clear(id);
    });

    const persisted = await worker.evaluate(async () => {
      await queue;
      return (await chrome.storage.local.get('scrollguardV4')).scrollguardV4.usage['tiktok.com'];
    });
    // Move only this worker's clock four hours within one usage day. This tests
    // real tab-event enforcement after a long gap without sleeping for hours or
    // changing the system clock. Pure engine tests cover the 6 AM reset itself.
    await worker.evaluate(async () => {
      await queue;
      globalThis.__realDateNow = Date.now;
      const start = new Date();
      start.setHours(10, 0, 0, 0);
      state.day = E.dayKey(start.getTime());
      state.usage['tiktok.com'].breakUntil = start.getTime() - 1;
      Date.now = () => start.getTime() + 4 * 60 * 60 * 1000;
      await commit();
    });
    await expectBlockedVisit('https://www.tiktok.com/four-hours-later');
    assert.equal(await worker.evaluate(() => state.usage['tiktok.com'].baseMs), persisted.baseMs);
    await worker.evaluate(async savedUsage => {
      Date.now = globalThis.__realDateNow;
      state.day = E.dayKey(Date.now());
      state.usage['tiktok.com'] = savedUsage;
      await commit();
      for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
    }, persisted);

    // A new browser process must recover an exhausted allowance from disk.
    // Verify through the actual popup and its trusted storage API: Playwright
    // can expose a dormant MV3 target whose evaluate() never obtains a context.
    await context.close();
    console.log('Browser flow passed; checking persistent blocking after restart.');
    const restoredPopup = await launch(`${base}/popup/popup.html`);
    assert.deepEqual(await restoredPopup.evaluate(async () => {
      return (await chrome.storage.local.get('scrollguardV4')).scrollguardV4.usage['tiktok.com'];
    }), persisted);
    await expectBlockedVisit('https://www.tiktok.com/after-browser-restart');
    await restoredPopup.evaluate(async () => {
      for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
    });
    assert.deepEqual(errors, []);
    console.log(`PASS on ${os.platform()} ${os.release()} ${os.arch()}, Chromium ${browserVersion}: real MV3 startup, site setup, settings, active allowance, transient heartbeat rejection/retry, tab closure, native notification API, challenge retry/reload/grant, elapsed-clock deadline, expiry, reopening enforcement, popup, browser restart, and simulated four-hour blocking.`);
  } finally {
    await context?.close();
    const target = fs.realpathSync(profile), allowedRoot = fs.realpathSync(profileRoot);
    if (!target.startsWith(allowedRoot + path.sep)) throw new Error('Test profile is outside its expected directory.');
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
