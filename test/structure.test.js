// Cheap checks on the window chrome's own files, which merges have damaged
// before (a dropped closing brace left an empty permission strip on screen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ui = path.join(__dirname, '..', 'src', 'ui');
const read = (f) => fs.readFileSync(path.join(ui, f), 'utf8');

test('every stylesheet has balanced braces', () => {
  for (const f of fs.readdirSync(ui).filter((n) => n.endsWith('.css'))) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      assert.ok(depth >= 0, `${f}: a } without its {`);
    }
    assert.equal(depth, 0, `${f}: a { is never closed`);
  }
});

test('every page closes the elements it opens', () => {
  for (const f of fs.readdirSync(ui).filter((n) => n.endsWith('.html'))) {
    const html = read(f).replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of ['div', 'section', 'form', 'aside', 'header', 'main', 'ul', 'ol', 'label', 'button', 'span', 'p', 'h1', 'h2']) {
      const opened = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
      const closed = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(opened, closed, `${f}: <${tag}> opened ${opened} times, closed ${closed}`);
    }
  }
});
