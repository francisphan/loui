#!/usr/bin/env node
// Turns the failures of the nightly live checks (live.test.js) into GitHub
// issues: one issue per check, by its title; a check that is still failing
// the next night adds a comment to its open issue instead of opening another.
// Run by .github/workflows/integration.yml with `gh` signed in (GH_TOKEN).
//
//   node test/integration/report-live.js <report.json> [<link to the run>]
const fs = require('fs');
const { execFileSync } = require('child_process');

const [file, run = ''] = process.argv.slice(2);
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

let results;
try {
  results = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  // The checks never got as far as writing how they went.
  results = [{ title: 'The live checks themselves run', ok: false, detail: 'The nightly run ended without a report: see its log.' }];
}

for (const r of results.filter((x) => !x.ok)) {
  const title = `Live check failing: ${r.title}`;
  const body = [
    'A nightly check against the real site failed (`test/integration/live.test.js`).',
    run && `Run: ${run}`,
    '```\n' + String(r.detail || 'no detail').replace(/```/g, "'''") + '\n```',
    'Run it by hand with `npm run test:live`. Close this issue once it passes again.',
  ].filter(Boolean).join('\n\n');
  const open = JSON.parse(gh('issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '20'));
  const existing = open.find((i) => i.title === title);
  if (existing) {
    gh('issue', 'comment', String(existing.number), '--body', `Still failing.\n\n${body}`);
    console.log(`commented on #${existing.number}: ${title}`);
  } else {
    console.log(`opened ${gh('issue', 'create', '--title', title, '--body', body).trim()}: ${title}`);
  }
}
