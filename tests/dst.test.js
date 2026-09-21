const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
test('6 AM follows local daylight saving boundaries (23-hour and 25-hour days)', () => {
  const output = execFileSync(process.execPath, ['-e', `
    const E = require('./lib/engine.js');
    const spring = new Date(2026, 2, 7, 6).getTime();
    const fall = new Date(2026, 9, 31, 6).getTime();
    console.log(JSON.stringify([(E.nextReset(spring)-spring)/3600000, (E.nextReset(fall)-fall)/3600000]));
  `], { cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, TZ: 'America/Chicago' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [23, 25]);
});
