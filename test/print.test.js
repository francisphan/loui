// Printing: the tab on screen can be saved as a PDF (File › Save as PDF…; the
// test saves it without the dialog). Print… (Ctrl+P) opens the system dialog,
// which a test cannot answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./drive');

let b;
test.before(async () => { b = await launch(); });
test.after(async () => { await b.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the page on screen saves as a PDF', async () => {
  const url = `${b.base}/second.html`;
  await b.ui('go', url);
  for (let i = 0; i < 50; i++) {
    const t = (await b.state()).tabs.find((x) => x.active);
    if (t.url === url && !t.loading && t.title === 'Second') break;
    await sleep(100);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-pdf-'));
  const file = path.join(dir, 'Second.pdf');
  try {
    assert.equal(await b.ui('print:pdf', file), 'ok');
    const pdf = fs.readFileSync(file);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 1000, 'it has content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
