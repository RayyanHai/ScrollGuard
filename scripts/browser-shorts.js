/* Optional-host permission and Shorts regression, run by browser-smoke.js. */
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function shortsSmoke({ context, worker, page, root, id }) {
  await context.route(/^https:\/\/(?:www\.|m\.)?youtube\.com\//, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>YouTube fixture</title><h1>Local YouTube navigation fixture</h1>',
  }));
  // Pre-authorize only YouTube in this disposable profile through Chromium's
  // extension-management API. The form still calls the real permissions.request
  // API: the former *:// request fails manifest validation even after this grant.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions');
  await manager.evaluate(async extensionId => {
    for (const host of ['http://*.youtube.com/*', 'https://*.youtube.com/*']) {
      await chrome.developerPrivate.addHostPermission(extensionId, host);
    }
  }, id);
  await manager.close();
  const regular = await context.newPage();
  await regular.goto('https://www.youtube.com/watch?v=regular');
  await page.bringToFront();
  await page.locator('#add-site').click();
  await page.locator('#site-domain').fill('youtube.com/shorts');
  assert.equal(await page.locator('#site-scope').inputValue(), 'shorts');
  await page.locator('#site-limit').fill('0.1');
  await page.screenshot({ path: path.join(root, 'test-results/shorts-add.png'), fullPage: true });
  await page.locator('#save-site').click();
  await page.waitForFunction(() => !document.getElementById('site-dialog').open || document.getElementById('site-error').textContent);
  assert.equal(await page.locator('#site-error').textContent(), '', 'Adding an optional host must not fail manifest validation');
  assert.match(await page.locator('#site-table').textContent(), /youtube.com\/shorts/);
  assert.equal(await worker.evaluate(() => state.sites.find(s => s.domain === 'youtube.com').scope), 'shorts');
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await page.locator('#site-scope').inputValue(), 'shorts', 'Editing must preserve the selected scope');
  await page.locator('#cancel-site').click();
  // Keep this scenario quiet; notification delivery is covered by the main smoke.
  await worker.evaluate(() => { state.settings.notifications = false; });
  await regular.bringToFront();
  await regular.waitForTimeout(2200);
  assert.equal(await worker.evaluate(() => state.usage['youtube.com'].activeMs), 0, 'Regular videos do not use the Shorts allowance');
  await regular.evaluate(() => history.pushState({}, '', '/shorts/first'));
  const deadline = Date.now() + 10000;
  while (await worker.evaluate(() => state.usage['youtube.com'].activeMs) < 1000) {
    assert.ok(Date.now() < deadline, 'Navigation into Shorts must start the active-use counter');
    await regular.waitForTimeout(200);
  }
  await regular.evaluate(() => history.pushState({}, '', '/watch?v=regular'));
  await regular.waitForTimeout(1200);
  const pausedUsage = await worker.evaluate(() => state.usage['youtube.com'].activeMs);
  assert.ok(pausedUsage >= 1000 && pausedUsage < 6000, `Expected some Shorts usage below the limit, got ${pausedUsage}ms`);
  await regular.waitForTimeout(1200);
  assert.equal(await worker.evaluate(() => state.usage['youtube.com'].activeMs), pausedUsage, 'Leaving Shorts pauses accounting');
  const survivor = await context.newPage();
  await survivor.goto('https://www.youtube.com/watch?v=unlimited');
  const otherShort = await context.newPage();
  await otherShort.goto('https://m.youtube.com/shorts/another');
  await regular.bringToFront();
  const otherClosed = otherShort.waitForEvent('close');
  await regular.evaluate(() => history.pushState({}, '', '/shorts/second')).catch(error => {
    if (!regular.isClosed()) throw error;
  });
  await Promise.all([regular.waitForURL('**/watch?v=regular'), otherClosed]);
  assert.equal(regular.isClosed(), false, 'Returning from Shorts must preserve the existing tab');
  assert.equal(new URL(regular.url()).pathname, '/watch');
  assert.equal(survivor.isClosed(), false, 'The limit must leave regular videos open');
  assert.equal(await worker.evaluate(() => state.usage['youtube.com'].baseMs), 6000);
  await regular.close();
  await survivor.close();
  await page.bringToFront();
  const removed = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'REMOVE_SITE', domain: 'youtube.com' }));
  assert.equal(removed.ok, true, removed.error);
  await worker.evaluate(async () => { state.settings.notifications = true; await commit(); });
  await page.reload();
  console.log('YouTube Shorts: native optional-host request, saved scope, SPA tracking/pause, previous-page return, and fresh-tab closure passed.');
};
