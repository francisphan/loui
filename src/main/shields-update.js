// Shields' list update, run in a utility process of its own (shields.js
// starts it): downloads the filter lists, builds the engine and writes it to
// the profile. Building takes a second and a few hundred MB for a moment; in
// a process of its own that memory goes back to the system when it exits,
// and the browser only ever loads the finished engine.
//
// argv: <engine file> <resources url, or '-'> <list url>...
const fs = require('fs');
const { FiltersEngine } = require('@ghostery/adblocker');

const [file, resources, ...lists] = process.argv.slice(2);

async function text(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

(async () => {
  const [bodies, scripts] = await Promise.all([
    Promise.all(lists.map(text)),
    resources === '-' ? null : text(resources),
  ]);
  const engine = FiltersEngine.parse(bodies.join('\n'));
  if (scripts) engine.updateResources(scripts, String(scripts.length));
  const temp = `${file}.${process.pid}`;
  fs.writeFileSync(temp, engine.serialize());
  fs.renameSync(temp, file); // the browser never reads a half-written engine
})().then(() => process.exit(0), (err) => {
  console.error('Shields could not update its lists:', err.message);
  process.exit(1);
});
