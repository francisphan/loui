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

The approval page names the site that will receive access. The relay only sends
sign-ins to `claude.ai`, `claude.com` and this machine; `LOUI_REDIRECT_HOSTS`
(comma-separated) adds others. Connector sign-ins last 30 days from last use.
To revoke everything at once, replace the key: delete `~/.config/loui-relay/key`,
restart the relay, and give the new key to each Loui install and to Claude Code.
Every connector then has to be approved again.

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
- **Your tabs are yours.** Sessions cannot list, read or act on them, or see
  what you pointed at in them. This is about tabs, not accounts: all tabs share
  one set of logins, so a session can open any site you are signed in to in a
  tab of its own. Treat a session's access as your access.
- **Handing a tab over.** Right-click a tab and choose *Give to …*, or a
  session can ask (`request_tab`) and you answer in the tab row. A tab you
  handed over comes back to you when the session ends; *Take back* does it
  sooner.
- **Take over** pauses the session working in the group on screen: tools that
  change the page are refused until you let it continue. Other groups carry on.
- **When a session ends, its group closes.** A session ends when its app says
  so, or about a minute after its connection drops (Claude Code closing), or,
  for apps that hold no connection open, after 15 minutes without a call.
- **Your tabs come back after a restart** (and after an update), with their
  history and device size. Sessions' groups do not. `Ctrl+Shift+T` reopens
  the tabs you closed, most recent first.
- **Tabs you are not using sleep.** One of your tabs that has been out of
  sight for 15 minutes is unloaded to free its memory, and shown dimmed; it
  loads again, where you left it, when you open it. Restored tabs start
  asleep. Never put to sleep: the tab on screen, tabs playing sound, asking
  for a permission, downloading or holding unsent form input, sessions' tabs,
  and sites you keep awake (right-click a tab). Right-click a tab and choose
  *Sleep this tab now* to do it at once. Change the time with
  `"sleepAfterMinutes"` in `settings.json` in the profile (0 turns it off).
- **Background speed.** Your tabs out of sight are throttled like in any
  browser. A session's tabs run at full speed while it works in them.

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
time. The icon's source files are in `build/` (`icon.svg`, `icon.ico`,
`icon.png`); `src/ui/icon.png` is the window's.

- Profile: `%APPDATA%\loui`. Put the relay address and key in the panel, or in
  `relay.json` there.
- *File › Open Loui when I sign in* keeps it reachable.
- The Claude panel runs Claude Code: an installed `claude.exe` if there is
  one, otherwise Claude Code inside WSL (`wsl.exe`), with your WSL login.
- **Updates.** An installed copy checks GitHub Releases shortly after launch and
  every six hours, downloads a new version in the background, and installs it
  when Loui quits. *Restart to update* in the toolbar (and the File menu)
  installs it at once. Each download is checked against the SHA-512 published
  with the release; the builds are unsigned, so there is no publisher check.

## Releasing

1. Set `version` in `package.json` and commit.
2. `git tag v<version> && git push origin main v<version>`

`.github/workflows/release.yml` runs the tests, builds the Windows installer
and publishes it with `latest.yml` as a GitHub release, which installed copies
then update to.

## Downloads

Files are saved to your Downloads folder without asking (`LOUI_DOWNLOADS`
overrides the folder). A file never replaces one already there: the second
`report.pdf` becomes `report (1).pdf`. The downloads button in the toolbar
(`Ctrl+J`) shows how far running downloads have got and opens the list, where
you can pause, resume or cancel them, and open a finished file or show it in
its folder. *Ask where to save each file* there brings back the Save As dialog
for downloads you start. Downloads that start in a Claude session's tab are
saved and listed too, with the session's name; they never open a dialog, and
sessions have no way to open a downloaded file. The last 50 are kept in
`downloads.json` in the profile.

## Appearance

Dark by default. *View › Appearance* switches to Light or Match system; the
choice is kept in `settings.json` in the profile. Pages see it as
`prefers-color-scheme`. Under WSL, *Match system* follows Linux's setting, not
Windows'.

## History

Pages you visit in your own tabs are kept in `history.json` in the profile
(title, address, number of visits, last visit). Pages that Claude sessions open
in their tab groups are not, nor are tabs while you have handed them to a
session. Typing in the address bar suggests pages from it, ranked by how often
and how recently you visited them; the arrow keys move through them, Enter
opens one, Esc closes the list. *History* (`Ctrl+H`, or the clock in the
toolbar) lists everything, with search, removal of single pages, and *Clear all*.

## Shields

Ads and trackers are blocked in every tab, with EasyList, EasyPrivacy, Peter
Lowe's list and uBlock Origin's filters (Ghostery's maintained copies of them,
matched by Ghostery's engine). Requests on the lists are cancelled, or answered
with a harmless stand-in script where the lists say so; once a page is parsed,
the empty boxes ads leave behind are hidden. The shield in the toolbar shows how
many requests were blocked on the page on screen; its menu turns Shields off
for the site (its host name), which is kept in `shields.json` in the profile.

The lists are not downloaded at start: the finished engine is kept in
`shields/engine.bin` in the profile (about 7 MB on disk, about 15 MB in memory),
and rebuilt in a background process of its own when it is more than four days
old. Until the first download is done, nothing is blocked.
## Search, printing, and Brave

*File › Settings* picks the search engine for words typed in the address bar:
Brave Search (the default), DuckDuckGo, Google, Kagi, or an address of your own
with `%s` where the words go. It is kept in `settings.json` in the profile.

*File › Print…* (`Ctrl+P`) opens the system print dialog for the tab on screen;
*File › Save as PDF…* saves it as a PDF.

Google refuses to sign in from browsers it considers embedded, Loui included,
and Loui does not pretend to be another browser to get past that. Instead:

- *Open in Brave* (right-click a tab, or the File menu) hands the page's
  address to Brave (or, without Brave, the system's default browser).
- Sites on a list in *File › Settings* (`accounts.google.com` to begin with)
  are sent to Brave when one of your tabs opens them, and the tab says so, with
  a link that takes the site off the list. Claude's tabs don't open them at all,
  and a session is told to ask you; Claude never makes Loui open another
  program.

## Layout

```
src/shared/tools.js   the tool list (relay and panel both advertise it)
src/main/main.js      window, menu, requests from the window chrome
src/main/tabs.js      views, tab groups, console and network history, device sizes
src/main/sessions.js  sessions and their groups, take over, hand-over
src/main/restore.js   your tabs across restarts (tabs.json), reopening closed tabs
src/main/actions.js   what each tool does
src/main/link.js      the connection out to the relay
src/main/rpc.js       local control socket, used by the tests
src/main/chat.js      the Claude panel (Agent SDK)
src/main/updater.js   updates for installed copies (GitHub Releases)
src/main/downloads.js downloads: where they are saved, the list, pause and resume
src/main/permissions.js  camera, microphone, location, notifications, screen: asking and remembering
src/main/history.js   history: what the user visits in their own tabs (history.json)
src/main/suggest.js   address bar suggestions: their sources, and the list in front of the page
src/main/requests.js  the one onBeforeRequest listener: the relay guard first, then Shields
src/main/shields.js   Shields: blocking, hiding ad boxes, the per-site switch, list updates
src/main/shields-update.js  downloads the lists and builds the engine, in a process of its own
src/main/search.js    the search engine for the address bar
src/main/brave.js     Open in Brave, and the sites that open there instead of in Loui
src/main/print.js     printing and Save as PDF
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
- Sessions' tabs cannot load the relay's own addresses (the relay tells each
  browser what they are), and the relay answers only to those addresses, so a
  session cannot reach the approval page under another name either.
- The relay refuses to start with a key shorter than 32 characters.
- A session belongs to whoever opened it; another token cannot use it.
- Tabs are sandboxed and get no preload script or Node access.
- Sessions can open only `http` and `https` pages. Page content is passed to
  Claude as untrusted data.
- Sites get clipboard-write, fullscreen and pointer lock without asking. For
  the camera, microphone, location, notifications and screen sharing, Loui asks
  you in a strip above the page, naming the site by its address; an answer
  lasts until you leave the page unless you tick *Remember for this site*
  (screen sharing is asked every time). *File › Site permissions* lists what
  is remembered and forgets it. Tabs in a Claude session's group, including
  tabs you handed over, are refused without asking. Every other permission is
  refused.

## Not here yet

- iPhone and iPad app (needs an Apple Developer account and a Mac to build).
- Dragging tabs between groups; a prompt when a new session first connects.
- Bookmarks, password manager,
  extensions. Signing in to Google in Loui (see *Search, printing, and Brave*).
