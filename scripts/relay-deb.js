#!/usr/bin/env node
// Builds dist/loui-relay_<version>_all.deb: the relay (relay/) as a Debian
// package for a server, with its systemd service (build/linux/relay/). See
// "Debian" in the README.
//
//   npm run dist:relay
//
// The package holds the relay's own files and, from node_modules, exactly the
// packages it needs at the versions package-lock.json pins (so `npm ci` first);
// it runs on Debian's own nodejs. Needs dpkg-deb, which any Debian or Ubuntu has.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json')).packages;
const from = path.join(root, 'build', 'linux', 'relay');
const stage = path.join(root, 'dist', 'loui-relay-deb');
const lib = path.join(stage, 'usr', 'lib', 'loui-relay');

// What relay/*.js and src/shared/tools.js require.
const NEEDS = ['express', 'ws', 'zod', '@modelcontextprotocol/sdk'];

// The packages those need in turn, as node would find them: nearest
// node_modules first. Returns lock keys ("node_modules/a/node_modules/b").
function closure(names) {
  const seen = new Set();
  const find = (name, fromKey) => {
    for (let at = fromKey; ; at = at.slice(0, Math.max(0, at.lastIndexOf('/node_modules/')))) {
      const key = `${at ? `${at}/` : ''}node_modules/${name}`;
      if (lock[key]) return key;
      if (!at) return null;
    }
  };
  const walk = (name, fromKey, optional) => {
    const key = find(name, fromKey);
    if (!key) {
      if (optional) return;
      throw new Error(`${name} (needed by ${fromKey || 'the relay'}) is not in package-lock.json`);
    }
    if (seen.has(key)) return;
    seen.add(key);
    const p = lock[key];
    const maybe = new Set([...Object.keys(p.optionalDependencies || {}), ...Object.entries(p.peerDependenciesMeta || {}).filter(([, m]) => m.optional).map(([n]) => n)]);
    for (const dep of new Set([...Object.keys(p.dependencies || {}), ...Object.keys(p.peerDependencies || {}), ...Object.keys(p.optionalDependencies || {})])) {
      walk(dep, key, maybe.has(dep));
    }
  };
  for (const n of names) walk(n, '', false);
  return [...seen].sort();
}

// A package's own files, without the packages nested under it (those that
// are needed are copied on their own).
function copyPackage(key) {
  const src = path.join(root, key);
  if (!fs.existsSync(path.join(src, 'package.json'))) throw new Error(`${key} is not installed: run npm ci first`);
  fs.cpSync(src, path.join(lib, key), { recursive: true, dereference: true, filter: (f) => path.basename(f) !== 'node_modules' || f === src });
}

const put = (file, to, mode = 0o644) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(file, to);
  fs.chmodSync(to, mode);
};

fs.rmSync(stage, { recursive: true, force: true });
const keys = closure(NEEDS);
for (const key of keys) copyPackage(key);
for (const f of ['relay/server.js', 'relay/auth.js', 'src/shared/tools.js']) put(path.join(root, f), path.join(lib, f));
fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: 'loui-relay', version: pkg.version, private: true }, null, 2) + '\n');
put(path.join(from, 'node18.js'), path.join(lib, 'node18.js'));
put(path.join(from, 'loui-relay.service'), path.join(stage, 'usr', 'lib', 'systemd', 'system', 'loui-relay.service'));
put(path.join(from, 'default'), path.join(stage, 'etc', 'default', 'loui-relay'));
put(path.join(root, 'README.md'), path.join(stage, 'usr', 'share', 'doc', 'loui-relay', 'README.md'));

// Whatever umask the checkout had: directories 755, files 644 (programs 755).
let installed = 0;
(function tidy(dir) {
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { tidy(p); continue; }
    const st = fs.statSync(p);
    installed += st.size;
    fs.chmodSync(p, st.mode & 0o100 ? 0o755 : 0o644);
  }
})(stage);

const control = path.join(stage, 'DEBIAN');
fs.mkdirSync(control, { mode: 0o755 });
fs.writeFileSync(path.join(control, 'control'), [
  'Package: loui-relay',
  `Version: ${pkg.version}`,
  'Architecture: all',
  'Maintainer: Francis Phan <francisphan@users.noreply.github.com>',
  `Installed-Size: ${Math.ceil(installed / 1024)}`,
  'Depends: nodejs (>= 18), adduser, init-system-helpers',
  'Section: net',
  'Priority: optional',
  `Homepage: ${pkg.homepage}`,
  'Description: Relay between Claude sessions and Loui browsers',
  ' Claude sessions anywhere reach a Loui browser through this small service:',
  ' they speak MCP to it over HTTP, and each Loui keeps a connection open to it.',
  ' It listens on 127.0.0.1:7332 and runs as a service of its own user.',
  '',
].join('\n'));
fs.writeFileSync(path.join(control, 'conffiles'), '/etc/default/loui-relay\n');
for (const script of ['postinst', 'prerm', 'postrm']) put(path.join(from, script), path.join(control, script), 0o755);

const out = path.join(root, 'dist', `loui-relay_${pkg.version}_all.deb`);
execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, out], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${keys.length} packages from node_modules, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
