// The person at a headless Loui's window, for debian.test.js: waits for
// "Let … use Loui?" and answers it with "Always allow", then prints what was
// asked. Run as the user that Loui runs as, which must have been started with
// LOUI_TEST=1 (its control socket is that user's alone).
//
//   node allow.js <profile directory>
const { attach } = require('../../drive');

(async () => {
  const b = await attach(process.argv[2], 60000);
  for (const end = Date.now() + 120000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const p = (await b.state()).prompt;
    if (p?.kind !== 'consent') continue;
    await b.ui('prompt:answer', { id: p.id, value: 'always' });
    console.log(JSON.stringify(p));
    b.hangUp();
    return;
  }
  b.hangUp();
  console.error('nothing was asked');
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
