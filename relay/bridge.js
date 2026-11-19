#!/usr/bin/env node
// For an app that can only start a local MCP server as a program (Claude
// Desktop's "mcpServers"): this is that program. It passes every message
// between the app (stdin/stdout) and the relay on this machine, signing in
// with the relay key read from its file, so the key is not written into the
// app's settings.
//
//   node relay/bridge.js            the relay at http://127.0.0.1:7332/mcp
//   LOUI_RELAY_URL, LOUI_RELAY_HOME  another address, another folder for the key
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const home = process.env.LOUI_RELAY_HOME || path.join(os.homedir(), '.config', 'loui-relay');
const url = new URL(process.env.LOUI_RELAY_URL || 'http://127.0.0.1:7332/mcp');
const fail = (why) => { console.error(`loui bridge: ${why}`); process.exit(1); };

let key;
try { key = fs.readFileSync(path.join(home, 'key'), 'utf8').trim(); } catch { fail(`no relay key in ${home}`); }

const app = new StdioServerTransport();
const relay = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
// One at a time, in order: the relay names the session in its answer to the
// first message, and the ones after it must carry that name.
let last = Promise.resolve();
app.onmessage = (message) => {
  last = last.then(() => relay.send(message)).catch((e) => console.error(`loui bridge: ${e.message}`));
};
relay.onmessage = (message) => {
  // What a client of the relay does itself after the first answer.
  if (message.result?.protocolVersion) relay.setProtocolVersion?.(message.result.protocolVersion);
  app.send(message).catch(() => {});
};
// Either side going ends the other: the relay then closes the session's tab group.
app.onclose = () => relay.terminateSession().catch(() => {}).finally(() => process.exit(0));
relay.onclose = () => process.exit(0);
relay.onerror = (e) => console.error(`loui bridge: ${e.message}`);

relay.start().then(() => app.start()).catch((e) => fail(e.message));
