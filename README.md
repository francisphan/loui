# Loui

A web browser that Claude drives alongside you. You browse in it like any
other browser. Any Claude session (Claude Code, Claude Desktop, the Claude
apps) can work in it too, each in a tab group of its own, and you see every
step as it happens.

```bash
npm install
npm start          # open the browser
npm run relay      # run the relay in the foreground (normally a service, see below)
npm test           # end-to-end tests: real app, real relay, virtual display
npm run dist:win   # build the Windows installer into dist/
```

## How Claude sessions reach it

```
Claude session ── MCP over HTTP, signed in ──▶ relay ◀── WebSocket, kept open ── Loui
(Code, Desktop, web, phone)                  (your machine)                     (each install)
```

Neither side can reach the other directly, so both connect to the **relay**
(`relay/server.js`), a small service you host. It has no browser logic: it
knows who is signed in, which browsers are online, and which session is using
which browser. It listens on `127.0.0.1:7332` only.

There is one secret, the **relay key**, created on first run in
`~/.config/loui-relay/key`.

| Who | How it signs in |
| --- | --- |
| A Loui install | Relay address and key, in the panel under the connection lamp (or `relay.json` in its profile) |
| Claude Code on your machines | The key as a bearer token (command below) |
| Claude's connector (Desktop, web, phone, cloud sessions) | OAuth: you approve it once by entering the key on a page the relay serves |

### Claude Code

```bash
claude mcp add -s user --transport http loui http://127.0.0.1:7332/mcp \
  --header "Authorization: Bearer $(cat ~/.config/loui-relay/key)"
```

### Claude Desktop, the phone app, cloud sessions

These call the relay from Anthropic's servers, so it needs one public entrance.
Tailscale Funnel provides it. Port 8443 leaves the Funnel's main port free for
anything else the machine already serves:

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:7332
```

The relay must know its public address (`LOUI_PUBLIC_URL`, set in the service
unit). Then, in Claude's settings, add a custom connector with the URL
`https://<machine>.<tailnet>.ts.net:8443/mcp`. Claude opens the relay's
approval page; enter the relay key. To close the entrance again:
`tailscale funnel --https=8443 off`.

Everything the connector does passes through the relay, and anyone who has the
key can drive a signed-in browser. Keep the key private.

### Relay settings (environment)

| Variable | Meaning |
| --- | --- |
| `LOUI_RELAY_PORT` | Port, default 7332 |
| `LOUI_RELAY_HOME` | Where the key and connector sign-ins are kept, default `~/.config/loui-relay` |
| `LOUI_PUBLIC_URL` | The relay's public address, for OAuth |
| `LOUI_LAUNCH` | A command that opens Loui on the relay's machine when a session needs a browser and none is online |
| `LOUI_PRIMARY` | Name of the browser new sessions use when several are online (default: the one connected longest) |
| `LOUI_IDLE_MINUTES` | See "When a session ends", default 15 |

Run it as a service so it is always there, for example a systemd user unit
whose `ExecStart` is `node /path/to/loui/relay/server.js`, with the variables
above as `Environment=` lines. To move the relay to another machine,
copy this repository there, run `npm install --omit=dev`, start
`relay/server.js`, and change the address in each Loui install and in Claude.

## Tab groups

- **A session is responsible for a tab group.** The first time a session uses
  the browser it gets a group, named after it ("Claude Code · pung"). Its tools
  see and act on only that group. It works in the background: the tab you are
  looking at does not change.
- **Your tabs are yours.** Sessions cannot list, read or act on them.
- **Handing a tab over.** Right-click a tab and choose *Give to …*, or a
  session can ask (`request_tab`) and you answer in the tab row. A tab you
  handed over comes back to you when the session ends; *Take back* does it
  sooner.
- **Take over** pauses the session working in the group on screen: tools that
  change the page are refused until you let it continue. Other groups carry on.
- **When a session ends, its group closes.** A session ends when its app says
  so, or about a minute after its connection drops (Claude Code closing), or,
  for apps that hold no connection open, after 15 minutes without a call.

The **Claude panel** in the window is different: it is your own co-driver and
works in your tabs. It runs on your Claude Code login through the Agent SDK
(your subscription, no API key), and has browser tools only.

**Point** (`Ctrl+Shift+C`, or right-click an element) hands an element to
Claude with its selector, text, HTML and a cropped screenshot.

## Tools

`navigate`, `history`, `tabs`, `snapshot`, `click`, `type`, `press_key`,
`hover`, `select_option`, `scroll`, `wait_for`, `screenshot`, `evaluate`,
`console_logs`, `network_requests`, `set_viewport`, `request_tab`, `picks`,
`ask_user_to_pick`, and `devices` (list your browsers, or move to another).
`snapshot` returns the page as an outline whose elements carry refs like
`[e12]`; the acting tools take a ref. One list, in `src/shared/tools.js`.

## Windows

`npm run dist:win` builds `dist/Loui Setup 0.1.0.exe` on Linux in about half a
minute (no wine: `scripts/nowine/wine` stands in for the one step that wants
it). The build is unsigned, so Windows shows a SmartScreen warning the first
time, and it has the default icon.

- Profile: `%APPDATA%\loui`. Put the relay address and key in the panel, or in
  `relay.json` there.
- *File › Open Loui when I sign in* keeps it reachable.
- The Claude panel needs Claude Code installed on Windows; without it the
  panel says so, and other sessions still work.

## Layout

```
src/shared/tools.js   the tool list (relay and panel both advertise it)
src/main/main.js      window, menu, requests from the window chrome
src/main/tabs.js      views, tab groups, console and network history, device sizes
src/main/sessions.js  sessions and their groups, take over, hand-over
src/main/actions.js   what each tool does
src/main/link.js      the connection out to the relay
src/main/rpc.js       local control socket, used by the tests
src/main/chat.js      the Claude panel (Agent SDK)
src/page/lib.js       runs inside each page: outline, element lookup, pointer, picker
src/ui/               tab strip, toolbar, panel
relay/                the relay and its sign-in
test/                 end-to-end tests
```

Two things in `tabs.js` and `main.js` were found by experiment and are easy to
break:

- Clicks and screenshots only work on a tab whose view was in sight while its
  page loaded. Background tabs therefore "peek" (one pixel column at the edge
  of the page area) during a load and are tucked underneath afterwards.
- A window covered by other windows stops rendering unless the three
  command-line switches at the top of `main.js` are set.

## Safety

- Nothing in Loui listens for connections; it dials out to the relay. The
  relay listens on loopback only.
- Tabs are sandboxed and get no preload script or Node access.
- Sessions can open only `http` and `https` pages. Page content is passed to
  Claude as untrusted data.
- Sites may ask for clipboard-write, fullscreen and pointer lock; every other
  permission is refused.

## Not here yet

- iPhone and iPad app (needs an Apple Developer account and a Mac to build).
- Dragging tabs between groups; a prompt when a new session first connects.
- Downloads list, find in page, bookmarks, history view, password manager,
  extensions. Sites that block embedded browsers at sign-in (Google does) may
  refuse to log in.
