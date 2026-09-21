const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let count = 0;
for (const dir of ['background', 'content', 'lib', 'challenge', 'scripts', 'tests']) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    new vm.Script(fs.readFileSync(path.join(dir, file), 'utf8'), { filename: path.join(dir, file) });
    count++;
  }
}
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page]) {
  if (!fs.existsSync(file)) throw new Error(`Missing manifest file: ${file}`);
}
for (const dir of ['popup', 'options', 'dashboard', 'challenge']) {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|png))"/g)) {
      if (!fs.existsSync(path.resolve(dir, match[1]))) throw new Error(`Missing resource: ${dir}/${match[1]}`);
    }
  }
}
console.log(`Syntax OK: ${count} JavaScript files. Manifest and page resources OK.`);
