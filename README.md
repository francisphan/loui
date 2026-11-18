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
npm run test:integration   # a whole session through a relay of its own (see Testing)
npm run dist:win   # build the Windows installer into dist/
npm run dist:linux # build the Debian package into dist/ (and dist:relay, the relay's)
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

### Several devices, and saying where

Each Loui install signs in to the relay under a name: its computer's name
(with " (WSL)" added inside WSL), or the one you give it in *Settings › Claude ›
This browser's name on the relay*. The relay remembers every browser that has
signed in (`devices.json` in its home: id, name, platform, version, last seen;
the latest 50), so a session can be told about one that is closed right now.

Say where you want the session: **"launch a Loui browser session on FPMoss"**,
or "use Loui on the laptop". Claude calls `devices` with that name and
`start: true` before anything else, and its tab group opens there. Names match
in any case, and the start of a name is enough when only one begins that way
("fpm"). `devices` with no name lists the browsers: online first, then the
ones seen before with when, and for each whether the relay can start it.

The relay can only start Loui on its own machine, and only with a command you
gave it. `launch.json` in the relay's home maps device names to shell commands:

```json
{
  "FPMoss": "'/mnt/c/Users/you/AppData/Local/Programs/loui/Loui.exe'",
  "*": "DISPLAY=:0 /path/to/loui/node_modules/.bin/electron /path/to/loui"
}
```

On Debian, with Loui installed from its package, the command is the installed
program: `"mydesktop": "DISPLAY=:0 /opt/Loui/loui"` for a relay that runs as
you on a desktop, or the headless service on a server (see *Debian*).

`"*"` is the command for a session that names no device while no browser is
online (the same as `LOUI_LAUNCH`). The file is read each time, so editing it
needs no restart. `LOUI_LAUNCH_<NAME>` in the environment does the same for a
name made of letters, digits and `_`; the file wins. With `start: true` the
relay runs the command and waits up to 30 seconds for a browser of that name
to sign in. For a device it has no command for, it says so, and Claude asks you
to open Loui there (*Settings › General › Open Loui when I sign in* keeps a
machine reachable). The commands are yours alone: a tool call can name a
device, never give or change a command, and nothing a browser says about
itself is run.

### Relay settings (environment)

| Variable | Meaning |
| --- | --- |
| `LOUI_RELAY_PORT` | Port, default 7332 |
| `LOUI_RELAY_HOME` | Where the key, connector sign-ins, `devices.json` and `launch.json` are kept, default `~/.config/loui-relay` |
| `LOUI_PUBLIC_URL` | The relay's public address, for OAuth |
| `LOUI_LAUNCH` | A command that opens Loui on the relay's machine when a session needs a browser, names none, and none is online (`"*"` in `launch.json`) |
| `LOUI_LAUNCH_<NAME>` | The command that opens the Loui called `<NAME>` (any case) on the relay's machine; see above |
| `LOUI_PRIMARY` | Name of the browser new sessions use when several are online (default: the one connected longest) |
| `LOUI_IDLE_MINUTES` | See "When a session ends", default 15 |

Run it as a service so it is always there. On a Debian server, install the
`loui-relay` package, which brings its own service (see *Debian*). From a
checkout, a systemd user unit whose `ExecStart` is
`node /path/to/loui/relay/server.js`, with the variables above as
`Environment=` lines, does the same. To move the relay to another machine,
install the package there (or copy this repository, run
`npm install --omit=dev` and start `relay/server.js`), copy the relay's home
across if the key and sign-ins should stay the same, and change the address in
each Loui install and in Claude.

## Tab groups

- **Loui asks before a new session first uses it.** "Let Claude Code · pung
  use Loui?" appears in the tab row, and the session's first call waits for
  your answer (two minutes, then it is refused and may ask again). *Always
  allow* remembers the connector it signed in with (the relay key, or one
  approved Claude connector), never the single session; *File › Settings*
  lists those and revokes them. They are kept in `consent.json` in the
  profile. A session you deny gets no tab group and is refused until it ends.
  The Claude panel is never asked.
- **One question at a time.** Questions from sessions (may it come in, may it
  have this tab, point at something) wait in line in the tab row, each naming
  the session asking, with a count of those still waiting. Each gets its full
  time once it is shown; a session that ends takes its questions with it.
- **A session is responsible for a tab group.** The first time a session uses
  the browser it gets a group, named after it ("Claude Code · pung"). Its tools
  see and act on only that group. It works in the background: the tab you are
  looking at does not change.
- **Your tabs are yours.** Sessions cannot list, read or act on them, or see
  what you pointed at in them. This is about tabs, not accounts: all tabs share
  one set of logins, so a session can open any site you are signed in to in a
  tab of its own. Treat a session's access as your access.
- **Handing a tab over.** Drag one of your tabs onto a session's group, or
  right-click it and choose *Give to …*, or a session can ask (`request_tab`)
  and you answer in the tab row. A tab you handed over comes back to you when
  the session ends; dragging it back among your tabs, or *Take back*, does it
  sooner. A session's tabs can be reordered within its group, never moved to
  another session.
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
  *Sleep this tab now* to do it at once. Change the time in *File › Settings*
  (`"sleepAfterMinutes"` in `settings.json` in the profile; 0 turns it off).
- **Background speed.** Your tabs out of sight are throttled like in any
  browser. A session's tabs run at full speed while it works in them.
- **Arranging tabs.** Drag a tab to reorder it, or move the tab on screen
  with `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown`. Right-click a tab and
  choose *Pin tab* (or drop it among the pinned ones): pinned tabs are icons
  at the start of your tabs, come back after a restart already loaded, never
  sleep, and `Ctrl+W` leaves them open (close one from its menu).
- **Keyboard.** `Ctrl+Tab` and `Ctrl+Shift+Tab` (or `Ctrl+PageDown` and
  `Ctrl+PageUp`) go round your own tabs in the window, or round a session's
  group when one of its tabs is on screen; a sleeping tab they pass over stays
  asleep. `Ctrl+1` to `Ctrl+8` show your nth tab and `Ctrl+9` the last.
  `Ctrl+W` on a session's tab asks first, and does nothing while the session
  is working. Also: `F5` and `Ctrl+Shift+R` (reload, and without the cache),
  `Alt+D` or `F6` (address bar), `F11` (full screen), `Ctrl+,` (Settings),
  `Ctrl+Shift+Delete` (clear history), `Alt+Shift+P` (pin). In the tab strip
  and the bookmarks bar the arrow keys move from one item to the next. Esc
  closes any panel or strip, and the page has the keyboard again.
- **Full screen.** `F11`, or a page's own full-screen button, gives the page
  the whole window. Loui says over the page whose it is and how to leave
  (`Esc` for the page's, `F11` for yours), for a few seconds and again when
  the pointer touches the top edge. A page gets the screen only right after
  your own click or key in it, never after a Claude session's; and a question
  for the window (a session's, a guardrail's, a site's permission) ends it.
- **The menu button** at the end of the toolbar has a short menu: new tab and
  windows, History (the tab closed last and the last few pages; with neither,
  it opens the panel), Bookmarks, Downloads, Passwords, Zoom (one row that
  says the level), Find, Print, Full screen, Claude (with the connection to
  other Claude sessions), More tools (reader view, site permissions, device
  size, developer tools), Task manager, Settings, checking for updates, About,
  Quit. It holds everything there is to do. The full menus are in the command palette and behind their shortcuts.
- **Louis**, at the top left of the window, is a button (`Alt+L`): Loui's own
  menu, about Loui and how it looks. Appearance, vertical tabs, the bookmarks
  bar, Settings (and the start page's), checking for updates, About.
- **Vertical tabs.** *View › Vertical tabs* (or *File › Settings*) moves the
  tabs to a sidebar on the left: pinned tabs as a grid of icons, your tabs,
  then each session's group with what it is doing. The button at the top
  left collapses it to icons; a collapsed sidebar opens while the pointer
  rests on it. The page makes room rather than being covered, since nothing
  can be drawn over a page. Kept in `settings.json` (`"verticalTabs"`,
  `"sidebarCollapsed"`).
- **Watching a session in a small window.** Right-click one of a session's
  tabs and choose *Watch in a small window*, or press *Watch* in the helm
  while it works: a small window that stays on top shows a live picture of
  the tab it is working in (following it to a new tab), what it is doing, and
  *Take over* / *Let Claude continue*. Click the picture to show that tab.
  Drag it by its bar and resize it from its edges; dropped near a screen edge
  it snaps to it, and it opens where it was last time (`"pip"` in
  `settings.json`), at first in the bottom right corner. When the session
  ends it says so and closes. The pictures are the tab's own frames, scaled
  down: at most five a second while the page changes, none while it is still,
  and none while the small window is hidden, minimised or closed. Sessions
  cannot open or see it.
- **Task manager** (`Shift+Esc`, or *View › Task manager*) shows what each
  tab costs, in a small window of its own: private memory, working set and CPU
  for every tab (yours, and each session's with its group's name), sleeping
  tabs at zero, the window chrome, the GPU process, utility processes (the
  network service, the Shields list builds), the Claude panel's Claude Code
  while it answers, and Loui's main process. Chromium can run several tabs in
  one process; they are then listed together, with the process's numbers once.
  Select a tab to show it, put it to sleep or close it; click a column to sort.
  It measures every second and a half while open and not at all once closed.
  On Linux private memory is shown only where `/proc` allows; under Windows the
  Claude panel's Claude Code is measured with `tasklist` (CPU to the second),
  and when it runs inside WSL it is listed without numbers.

The **Claude panel** in the window is different: it is your own co-driver and
works in your tabs. It runs on your Claude Code login through the Agent SDK
(your subscription, no API key), and has browser tools only.

### Signing in to Claude

The panel has no login of its own: it uses Claude Code's, which is your Claude
subscription. Loui asks Claude Code whether it is signed in (`claude auth
status`, through the same Claude Code the panel runs, WSL included) when the
panel or Settings opens, and keeps the answer in memory for a few minutes.

- **Not signed in** (or the login has expired): the message box gives way to a
  card with **Sign in** and *I've signed in* (which asks again). *Sign in*
  runs Claude Code's own `claude auth login`. Claude Code opens your system's
  browser, and the card waits: *Finish signing in in your default browser, or
  open the page here.*, with *Cancel*. *Open the sign-in page here* opens the
  page in a new tab of your own instead; that page shows a code, which you
  paste into the card (masked, with *Show* beside it). When Claude Code is done
  Loui asks again, and the message box is back, or the card says why not.
- **Not known** (an older Claude Code without that command, or no answer in
  time): the message box stays. If a message is then turned away for want of
  a login, the card appears with what Claude Code said.
- **Claude Code not installed**: the card says so, with where to get it.
- Signed in with an API key or a cloud provider instead of a subscription:
  nothing is in the way; the panel's name says so when you point at it.
- *Settings › Claude › Claude account* shows the same, with *Sign in* and
  *Check again*.

No API key is involved, and Loui never reads Claude Code's credentials: it
only runs those two commands, with the API-key variables removed from their
environment. Nothing of the account is written down (not in `settings.json`,
not in the sessions' log), and the sign-in page is kept out of history and of
the tabs brought back. No tool is about any of this: a Claude session cannot
start a sign-in, see one, or read its address or code.

**Point** (`Ctrl+Shift+C`, or right-click an element) hands an element to
Claude with its selector, text, HTML and a cropped screenshot.

## More than one window, and private windows

- **New window** (`Ctrl+N`) opens another window with a tab of its own.
  *Close window* is `Ctrl+Shift+W`; closing the last window quits, as before.
- **Moving a tab.** Right-click a tab: *Move to new window*, or *Move to
  window* and pick one (named after the tab on screen in it). Dragging a tab
  out of the tab strip and letting go over another Loui window moves it there;
  letting go anywhere else opens a new window with it.
- **Sessions' tab groups** open in the normal window you focused last when the
  session started. Right-click the session's name in the tab strip (or one of
  its tabs) for *Move group to window*, or drag its name out of the strip; its
  tabs go along, and its tools work wherever the group is. When its window
  closes, the group moves to another window (the session carries on).
- **Closing a window** closes its tabs. Each window always has a tab of yours,
  like the single window did; a window whose last tab you move away closes.
- **Restore** brings back all your normal windows, each with its tabs.
- **Private window** (`Ctrl+Shift+N`): tinted indigo, marked *Private* beside
  the address bar and in its title. Its tabs use a session kept only in
  memory, shared by the private windows open at the same time and cleared when
  the last of them closes: no cookies, cache or site data survive, and none
  are shared with normal windows. Nothing goes into history, passwords are
  never offered to be saved (a saved one can be filled from the key in the
  address bar), permission answers are not remembered, it is never
  restored, and closed tabs in it cannot be reopened. Downloads from it are
  listed only in private windows and only while one is open (the files stay
  in your Downloads folder; one still running is cancelled). Shields and the
  relay guard work there as everywhere. The Claude panel and *Point* are not
  shown in it.
- **Sessions and private windows.** A session's group never goes in a private
  window. A session can still ask for the tab on screen (`request_tab`), and
  you can hand it one from a private window: the tab moves into the session's
  group (in a normal window) but keeps its private session, so the session
  sees that tab's private cookies and nothing else. When the session ends the
  tab goes back to its private window, or closes if no private window is left.
  The lent tab carries a small mask in the session's group, and closing the
  last private window while a session still holds one asks first.
- **Cost.** A second window costs one more window chrome renderer (roughly
  30 to 90 MB); a private window also an in-memory session. Nothing is made
  until you open one. The address suggestions list is one view that moves to
  the window you type in.

## Guardrails

Loui itself asks you before Claude pays, sends or deletes, whatever Claude was
told and whatever a page says to it. The tool call waits, nothing reaches the
page, and a strip above the page names the session, the site and the action,
with a picture of the button: *Allow once*, *Always on this site* (for that
kind of action), or *Block*. No answer in two minutes counts as Block; the
session is told the user declined. Ticking *Trust this session until it ends*
stops the questions for that session.

- **What is asked about:** clicking a control named like Pay, Buy, Place
  order, Purchase, Checkout, Transfer, Order, Book, Reserve, Send, Post,
  Publish, Delete, Remove account, Unsubscribe, Discard, Empty trash (and
  Pagar, Comprar, Reservar, Enviar, Publicar, Eliminar, Borrar, Descartar,
  Transferir, Confirmar compra), whether it is a button or anything else that
  takes clicks; Share, Reply, Subscribe and Upgrade (Compartir, Responder,
  Suscribirse) only on a form's own submit button or in a dialog, since
  elsewhere they open a menu, a box or a page; Confirm or Yes in a dialog
  about paying or deleting;
  submitting a form that holds card, password or one-time-code fields (by a
  click, or Enter); Enter in a chat box with a Send button beside it; opening
  a site on your list; `evaluate` on a page with card or password fields; and
  `evaluate` with code that reads like it clicks, submits or calls a handler
  (`.click(`, `.submit(`, `dispatchEvent(`, `el.onclick()`), on a page that
  has such a control.
  A click is judged on what it will land on (something laid over the element
  counts), and again just before it is sent.
- **What a script of Claude's does:** a click, a press of the mouse, a submit
  or an Enter that `evaluate` sends to such a control is stopped in the page
  and asked about, then let through if you allow it; so is what a `<select>`
  sets off when `select_option` changes it, a form `evaluate` posts (or a
  select, when its form holds more than the select), and a DELETE request
  without a body. The watch stays on until the page is left: what a script
  sends later, from a timer, is stopped and the session is told. It lets by
  what the page does in the second after real input and in the few seconds
  after an action you allowed, so a Send button that finishes its job by
  pressing a hidden one still works.
- **What the page does by itself:** while a session acts in a tab, for ten
  seconds after, and for as long as a page a script of its ran in stays
  open, any POST, PUT, PATCH or DELETE from that tab carrying a card
  number, password or one-time code is held until you answer, however it
  started (a "Next" button whose script submits a payment form,
  `form.submit()`, `fetch`). So is the tab going to a site on your list by a
  script, a form or a redirect.
- **Not caught:** a payment or deletion whose request carries none of those
  (an order placed with a saved card through an API call, a delete over
  `fetch`) unless the control that started it is named like one; a control
  with a name outside the list; a page acting more than ten seconds after the
  session's last action (where no script of the session's ran); a script that
  calls a handler in a way its text does not show (Loui sees events, not
  function calls); WebSockets.
- It covers every Claude session and the Claude panel (in your tabs, only while
  the panel is acting). Your own clicks are never interrupted.
- *File › Settings* turns it off, edits the list of sites, and forgets
  remembered answers. They are kept in `guardrails.json` in the profile.

## What sessions did

When a session ends its tab group closes, but Loui keeps a log of what it did.
*Sessions* in the Claude panel (or *Claude › Claude sessions…*) lists recent
sessions with when, how long, how many steps and how they ended (ended, you
closed it, connection lost, cut short when Loui closed, not let in). Opening
one shows each step in the words the panel used, the page it was on, whether
it failed, and a small picture of the tab after each step that acted on the
page; clicking a page opens it in a new tab of yours. Guardrails questions and
your answer to "Let … use Loui?" are steps too. The Claude panel's own steps go
to one *Claude panel* entry per day.

- Kept in `activity/` in the profile (one JSON per session, pictures beside
  it) for 7 days by default; the panel's *Keep for* changes that
  (`activityDays` in `settings.json`, 0 keeps nothing). At most 200 MB in all
  (`activityMaxMB`), oldest first. *Clear all*, or delete one session.
- Encrypted on disk where the system can encrypt (as for passwords), with a
  key of its own in `activity.key`; logs from before are encrypted at the
  next start. A profile copied to another machine or account cannot read
  them, and drops them.
- Text typed into password, card and one-time-code fields is stored only as
  its length; other typed text up to 200 characters, and only a script's first
  line. No tool reads the log: only the window does.

## Tools

`navigate`, `history`, `tabs`, `snapshot`, `read_article`, `click`, `type`, `press_key`,
`hover`, `select_option`, `scroll`, `wait_for`, `screenshot`, `evaluate`,
`console_logs`, `network_requests`, `set_viewport`, `request_tab`, `picks`,
`ask_user_to_pick`, and `devices` (list your browsers, online and offline, or
move to one by name, starting it if the relay can).
`snapshot` returns the page as an outline whose elements carry refs like
`[e12]`; the acting tools take a ref. `read_article` returns the page's
article as reader view finds it (title, byline, text with markdown-style
headings and lists, links as "text (url)"), cut off at 40,000 characters; it
only reads, so it works while the user has paused the session. One list, in
`src/shared/tools.js`.

## Windows

`npm run dist:win` builds `dist/Loui Setup 0.1.0.exe` on Linux in about half a
minute (no wine: `scripts/nowine/wine` stands in for the one step that wants
it). The build is unsigned, so Windows shows a SmartScreen warning the first
time. The icon's source files are in `build/` (`icon.svg`, `icon.ico`,
`icon.png`); `src/ui/icon.png` is the window's.

- Profile: `%APPDATA%\loui`. Put the relay address and key in the panel, or in
  `relay.json` there.
- *File › Open Loui when I sign in* keeps it reachable.
- **Default browser.** The installer registers Loui as a browser for your
  user (`build/installer.nsh`: `StartMenuInternet\Loui`, its capabilities for
  http, https, .htm and .html, and `RegisteredApplications`), and removes it
  on uninstall. Windows lets only you pick the default: *File › Make Loui your
  default browser…* opens Settings at Loui. A link opened in another app then
  opens in a new tab of yours, in the running Loui if there is one. Only
  http(s) addresses and existing .htm/.html files are taken from the command
  line, and Windows passes them after `--`, so a link is never read as a
  Chromium switch. (On Debian the package does the same with a desktop
  entry: see *Debian*.)
- The Claude panel runs Claude Code: an installed `claude.exe` if there is
  one, otherwise Claude Code inside WSL (`wsl.exe`), with your WSL login.
- **Updates.** An installed copy checks GitHub Releases shortly after launch and
  every hour, downloads a new version in the background, and installs it
  when Loui quits. *Restart to update* in the toolbar (and the Help menu)
  installs it at once. Each download is checked against the SHA-512 published
  with the release; the builds are unsigned, so there is no publisher check.

## Debian

Loui runs on Debian 12 (bookworm) and 13 (trixie), amd64, from a package:
`loui_<version>_amd64.deb` on the
[releases page](https://github.com/francisphan/loui/releases), about 110 MB.
A second, small package, `loui-relay_<version>_all.deb`, is the relay for a
server. `npm run dist:linux` and `npm run dist:relay` build them into `dist/`.

```bash
v=$(curl -fsSL https://api.github.com/repos/francisphan/loui/releases/latest | sed -n 's/.*"tag_name": "v\(.*\)".*/\1/p')
curl -fLO "https://github.com/francisphan/loui/releases/download/v$v/loui_${v}_amd64.deb"
sudo apt install "./loui_${v}_amd64.deb"
```

apt brings what it depends on (GTK 3, NSS, ALSA's library, the Liberation
fonts, `xdg-utils` and the like; all in Debian's main archive). The program is
`/opt/Loui/loui`, with `loui` on the PATH, a desktop entry (*Loui*, under
Internet) and the Louis icon. `sudo apt remove loui` takes it away and leaves
your profile.

- **Profile**: `~/.config/loui` (`LOUI_HOME` moves it).
- **Sandbox.** Chromium's sandbox is on, as installed: Debian lets an ordinary
  user make user namespaces, which is what Chromium uses; where a system
  refuses them (a hardened `kernel.unprivileged_userns_clone=0`), Chromium
  falls back to its `chrome-sandbox` helper, which the package installs
  setuid root for that. Loui is never started with `--no-sandbox`.
- **Default browser.** *Settings › General › Default browser* (or *File ›
  Make Loui your default browser*) runs `xdg-settings set default-web-browser
  loui.desktop` and shows what the system then says. Links from other apps
  arrive as `loui -- <link>` and open in a new tab of the running Loui.
- **Open Loui when I sign in** writes `~/.config/autostart/loui.desktop`,
  which GNOME, KDE, Xfce and the others start; switching it off removes it.
- **The window** has no title bar of the system's: the tab strip is the top of
  the window and Loui draws the window buttons at its right end. Drag the
  empty part of the strip to move it and double-click there to maximize. A
  dock groups its windows with the launcher by the class `loui`
  (`StartupWMClass`).
- **Passwords** are saved only where there is a keyring to encrypt them with
  (GNOME Keyring or KWallet: any GNOME or KDE desktop). Without one Loui does
  not save passwords, and keeps the relay key and the record of what sessions
  did as plain files only you can read; *Settings › Passwords › Encryption*
  says so.
- **The Claude panel** runs an installed Claude Code (the package leaves out
  the Agent SDK's own 380 MB copy, as the Windows installer does). Loui looks
  on the PATH, in `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`,
  `/usr/local/bin` and `/usr/bin`, and then asks your login shell for its
  PATH, so one installed through nvm is found too.
- **Voice.** Dictation needs a microphone and read-back needs voices from the
  system (`speech-dispatcher` with `espeak-ng`); without them the microphone
  button says there is none and nothing is read. Windows' `Win+H` has no
  counterpart here.
- **Updates.** An installed copy checks GitHub Releases as on Windows and
  downloads the new package in the background (to `~/.cache/loui-updater`).
  Installing a package takes an administrator: *Restart to update* asks for
  your password through the desktop's own prompt (polkit) and runs
  `apt-get install` on the downloaded file, then opens Loui again. Unlike on
  Windows, nothing is installed when Loui merely quits. Where nothing can ask
  for a password (no desktop, so no polkit agent; or `pkexec` not installed),
  the toolbar's button reads *Update downloaded* and it and *Settings › About*
  give the command to run instead, for example
  `sudo apt install ~/.cache/loui-updater/pending/loui_0.7.0_amd64.deb`
  (*Copy the command* in Settings copies it). The same is shown when the
  password prompt is dismissed, with *Try again* to ask for it once more.
  However the new version got installed, a running Loui notices and offers
  *Restart to finish updating*.

What differs from Windows: no installer registry entries (a desktop entry
instead), updates ask for a password and never install on quit, downloads get
no Mark of the Web (Linux has none), passwords need a keyring, and the panel
never falls back to WSL. There is no package for arm64: `electron-builder
--linux deb --arm64` would build one on the same runner, but it has never been
started on such a machine.

### The relay as a service

On the server that is to be the relay:

```bash
curl -fLO "https://github.com/francisphan/loui/releases/download/v$v/loui-relay_${v}_all.deb"
sudo apt install "./loui-relay_${v}_all.deb"     # needs Debian's nodejs, which apt brings
sudo cat /var/lib/loui-relay/key                 # the relay key: read it once, give it to each Loui and to Claude Code
```

The package holds the relay with exactly the modules it needs and installs
`loui-relay.service`, enabled and started. It is a service of the system, not
of a user: it starts with the machine, with nobody signed in, as a user of
its own (`loui-relay`) that owns nothing else, shut away from the rest of the
machine (`systemctl cat loui-relay` shows how: no access to `/home`, a
read-only system, no new privileges). That user cannot open a browser on
someone's desktop, which a server has no use for; on a desktop PC a user unit
from a checkout, as above, still can.

- **Home**: `/var/lib/loui-relay` (the key, connector sign-ins,
  `devices.json`, `launch.json`), readable by that user only.
- **Settings**: `/etc/default/loui-relay`, one `NAME=value` a line (the
  variables under *Relay settings*); then `sudo systemctl restart loui-relay`.
- **Log**: `journalctl -u loui-relay`.
- **Reaching it.** It listens on `127.0.0.1:7332` only. To give it a public
  address with Tailscale Funnel on port 8443 (Tailscale installed and signed
  in, Funnel allowed for the machine in the tailnet's policy):

  ```bash
  sudo tailscale funnel --bg --https=8443 http://127.0.0.1:7332
  tailscale funnel status          # shows https://<machine>.<tailnet>.ts.net:8443
  echo 'LOUI_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443' | sudo tee -a /etc/default/loui-relay
  sudo systemctl restart loui-relay
  ```

  That address goes in each Loui (*Settings › Claude*), in Claude Code's MCP
  entry and in Claude's connector. `sudo tailscale funnel --https=8443 off`
  takes it down.
- **Upgrading**: download the newer package and `sudo apt install` it. The
  service restarts (sessions connect again) and the key and sign-ins stay.
  `sudo apt remove loui-relay` leaves the home and the settings for a later
  install; `sudo apt purge loui-relay` removes them, key included.

### On a server with no screen

A Claude session can use a browser on the server itself: the installed Loui
on a virtual display (Xvfb), as a service for a user of your choosing. It
uses that user's profile (`~/.config/loui`), Downloads folder and Claude Code
login.

```bash
sudo apt install ./loui_${v}_amd64.deb xvfb
sudo sh -c 'umask 077; printf "LOUI_RELAY_URL=http://127.0.0.1:7332\nLOUI_RELAY_KEY=%s\n" "$(cat /var/lib/loui-relay/key)" > /etc/default/loui-headless'
sudo systemctl enable --now loui-headless@francis     # the user it runs as
```

`/etc/default/loui-headless` tells it which relay to sign in to (here the one
on the same machine); it then appears to sessions under the machine's name
(`devices`). It runs all the time and, idle with one blank tab, takes about
250 MB by systemd's count for the service (some 430 MB counting the program's
own files as it maps them), Xvfb included.

**Letting sessions in.** A new session is asked about in the window, here as
on a desktop: "Let … use Loui?". Nobody sees this window, so until it is
answered once with *Always allow* for the connector (the relay key, and each
of Claude's connectors), sessions are told that you did not answer. To answer
it, look at the virtual display while a session waits, over SSH:

```bash
sudo apt install x11vnc
# on the server; the display (:99 unless that was taken) and its key are on Xvfb's command line
sudo -u francis sh -c 'x11vnc -localhost -once -display :99 -auth "$(pgrep -a Xvfb | sed -n "s/.* -auth \([^ ]*\).*/\1/p")"'
# from your computer, then open vnc://localhost
ssh -L 5900:localhost:5900 server
```

The choice is kept in `consent.json` in the profile, per connector, and
*Settings › Claude* lists and revokes it. Loui has no setting that lets
sessions in unasked. To start it only when a session asks instead, leave it disabled, allow
the relay's user to start that one unit, and name it in the relay's
`launch.json`:

```bash
sudo tee /etc/polkit-1/rules.d/50-loui-headless.rules <<'EOF'
polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "loui-relay" &&
      action.lookup("unit") == "loui-headless@francis.service" && action.lookup("verb") == "start") return polkit.Result.YES;
});
EOF
echo '{ "*": "systemctl start loui-headless@francis" }' | sudo -u loui-relay tee /var/lib/loui-relay/launch.json
```

What is different with no screen, and how Loui says so:

- **No keyring**, so no passwords are saved; the relay key comes from
  `/etc/default/loui-headless` (root's to read) and the record of what
  sessions did is plain files in the profile, which is closed to other users.
- **No sound**: nothing to dictate into or read back with. Nothing fails.
- **Updates**: nobody is there to ask for a password. The service keeps
  running the version it started with; upgrade it as any package and restart:
  `sudo apt install ./loui_<new>_amd64.deb && sudo systemctl restart 'loui-headless@*'`.
- **No GPU**: pages are drawn in software. Screenshots and the pictures in
  the record of what sessions did work.
- **Questions** a session's work raises in the window (a guardrail's "may
  it buy this?", a tab to hand over, something to point at) go unanswered
  unless you are looking at the display; no answer in two minutes counts as no.
- `journalctl -u loui-headless@francis` is its log. Loui quitting (its last
  window closed) only makes the service start it again.

## Releasing

1. Set `version` in `package.json` and commit.
2. `git tag v<version> && git push origin main v<version>`

`.github/workflows/release.yml` runs the tests, builds the Windows installer
and publishes it with `latest.yml` as a GitHub release, which installed copies
then update to. A second job then builds the Debian packages and adds them to
the release with `latest-linux.yml`, which copies installed on Debian read;
if it fails, the Windows release stands.

## Testing

Three layers, from every commit to once a night.

**The suite, on every pull request.** `npm test` runs `test/*.test.js`: each
file starts the real app from this checkout on a throwaway profile, under a
virtual display, and drives it through its local control socket
(`test/drive.js`), with a real relay where the test needs one. Nothing in it
touches the network. One file at a time: `xvfb-run -a node --test
--test-force-exit test/tabstrip.test.js`. `.github/workflows/test.yml` runs it
on every pull request and on main; `release.yml` runs it before a release.

**The integration suite, on main and on a release tag.** What the suite cannot
reach is Loui as it is shipped and used (`test/integration/`,
`.github/workflows/integration.yml`):

- *Windows, packaged* (`windows.test.js`). The workflow builds the installer
  the way a release does, and a second one from the same commit with the next
  version number. On a Windows runner the first is installed silently and
  checked (files, the entry under Installed apps, the uninstaller's own
  checksum, the Start menu shortcut and its app id, the browser registration);
  the installed `Loui.exe` is driven over its named pipe (a session working in
  a background tab, the activity log, picture in picture, the palette,
  windows, reader view, full screen, tab icons, Settings); a saved password
  and the relay key are checked to be encrypted by Windows itself and to read
  back after a restart, with the tabs; then the app finds the second installer
  on a local server, downloads it, and *Restart to update* is expected to end
  with the new version running on the same profile; last, the uninstaller
  runs and must leave the profile. Logs, and a screenshot of each failure, are
  kept as the run's artifacts.
- *Debian, packaged* (`debian.test.js`). The workflow builds the two packages
  the way a release does, and again as the next version. For Debian 12 and for
  13, a container of that release with systemd as its first process
  (`test/integration/debian/Dockerfile`) gets the browser's package through
  apt, and the test checks what was installed (every library found, the
  sandbox helper's owner and mode, the desktop entry with
  `desktop-file-validate`, the icons, the headless unit), drives the installed
  `/opt/Loui/loui` on Xvfb under Xfce's window manager with the same checks
  as the Windows job (`checks.js` holds what the two share), plus the Linux
  ones: no process without the sandbox, the window's class, moving and
  maximizing the frameless window with the mouse, the default browser set
  through Settings and a link from `xdg-open` arriving in a tab, the autostart
  entry, and what is kept unencrypted where there is no keyring. Then the
  relay's package: its service really started by systemd, as its own user,
  answering on the loopback address only; a headless Loui as a service that an
  MCP session drives through that relay (a form, a screenshot); the relay's
  upgrade, removal and purge. Then updates from a local server: the command
  Loui gives where nothing can ask for a password, *Restart to update* through
  polkit (a rule stands in for the password prompt), and a package changed by
  apt under a running Loui. Last, `apt remove` and what it leaves.
- *Relay, end to end* (`relay-e2e.test.js`). The relay as a process of its
  own, a real Loui signed in to it with the key, and real MCP clients: Claude
  Code with the key, then Claude's connector through the whole OAuth flow
  (discovery, registration, the approval page, tokens, a refresh) over plain
  HTTP as claude.ai does it; navigating, typing, clicking, a screenshot,
  `read_article`, a guardrail question answered in the window, take over and
  hand back, a tab handed over, and the group closing when the session ends.

```bash
npm run test:integration                 # the relay story, here (Linux)
gh workflow run integration.yml          # all three, on GitHub; -f job=windows, -f job=debian or -f job=relay for one
```

The Windows file installs, updates and uninstalls the real per-user copy of
Loui, so it does those only on a GitHub-hosted runner, and checks that itself:
on a PC in use, a test of the uninstaller once deleted the installed Loui. On
your own Windows machine it will only *drive* a copy you point it at, on a
temporary profile, with the updater pointed at nothing:

```bat
set LOUI_INTEGRATION_ALLOW=1
set LOUI_INTEGRATION_EXE=C:\path\to\win-unpacked\Loui.exe
npm run test:integration:windows
```

Without `LOUI_INTEGRATION_ALLOW=1` (or CI) it refuses to run at all, and it
refuses `LOUI_INTEGRATION_INSTALLER` and `LOUI_INTEGRATION_UPDATE` anywhere
but on a hosted runner. The Debian file has the same guard: packages are
installed and removed, services started and the default browser changed only
on a hosted runner; elsewhere `LOUI_INTEGRATION_ALLOW=1
LOUI_INTEGRATION_EXE=/opt/Loui/loui npm run test:integration:debian` drives
an installed copy on a temporary profile (it needs `Xvfb`, `xfwm4`, `xdotool`
and ImageMagick's `import`). A release does not wait for this workflow: it runs
beside `release.yml` on the same tag.

**Live checks, nightly.** `live.test.js` is the only test that uses other
people's servers: Google's sign-in still accepts Loui (a made-up address must
get "Couldn't find this account", not the "may not be secure" page), Shields'
filter lists still download and build into an engine that blocks, and the
start page's default news feed still downloads and parses. It runs on a
schedule and by hand, never on a pull request; a check that fails on main
opens an issue named for it (or comments on the one already open) and fails
nothing else.

```bash
npm run test:live
gh workflow run integration.yml -f job=live
```

## Downloads

Files are saved to your Downloads folder without asking (`LOUI_DOWNLOADS`
overrides the folder). A file never replaces one already there: the second
`report.pdf` becomes `report (1).pdf`. The downloads button in the toolbar
(`Ctrl+J`) shows how far running downloads have got and opens the list, where
you can pause, resume or cancel them, try a cancelled or failed one again,
open a finished file or show it in its folder, and remove single rows. A
program, script, shortcut, installer, disk image or registry file says *Run…*
instead of *Open* and asks once more in its row. A running download shows its speed and time left, and *Stalled*
after ten seconds without a byte. *Ask where to save each file* there brings back the Save As dialog
for downloads you start. Downloads that start in a Claude session's tab are
saved and listed too, with the session's name; they never open a dialog, and
sessions have no way to open a downloaded file. The last 50 are kept in
`downloads.json` in the profile.

A page may start a download when you (or the session whose tab it is) just
acted in the tab, and one more per page load. Any others are stopped and
listed as blocked, with *Download anyway*.

## Settings

*File › Settings* (`Ctrl+,`, or "Settings" in the command palette) opens the
Settings window: sections down the left, a search box above them that finds a
setting by its name or description, and the chosen section on the right. A
change applies at once; there is no Save button. `Esc` or `Ctrl+W` closes it.

- **General**: appearance; whether Loui starts with the tabs from last time
  or a new tab (`"startup"`); open at sign-in and the default browser
  (installed copies); the downloads folder and *Ask where to save each file*;
  and the start page: what new tabs open with, and its parts (see *Start
  page*).
- **Tabs**: vertical tabs, the bookmarks bar, how long before a background
  tab sleeps (or never), and the sites that are never put to sleep.
- **Search**: the search engine, or an address of your own.
- **Privacy and security**: sites with Shields off and the filter lists
  (*Update now*), remembered site permissions, sites that open in your other
  browser, what pop-ups and private windows do, and *Clear browsing data*:
  browsing history (from the last hour, the last day, or all of it), cookies
  and site data (which signs you out of sites) and cached files (both always
  cleared whole: they carry no dates to go by) of your own windows. Saved
  passwords, bookmarks, settings, the session log and your Claude sign-in
  are not touched, and open tabs stay open.
- **Passwords**: whether saving is offered (`"offerPasswords"`; filling
  works either way), the sites never offered, the Passwords panel, import.
- **Claude**: the relay (address, key, on or off, status), connectors let in
  without asking, guardrails, how long and how much of what sessions did is
  kept, and the local control socket.
- **Reading**: reader view's text size, font and line width.
- **About**: versions, the profile folder, updates (*Check for updates now*,
  *Restart to update*), and the releases page.

It is a window of its own, like the task manager, not a tab: no page and no
Claude session can reach it, and it is sent no secret (the relay key is only
ever typed into it; passwords stay in the Passwords panel). It keeps no
settings itself: each control drives the module that owns the behaviour
(`src/main/settings-window.js`), so the menus, the window chrome and Settings
always agree. Values live where they always did: `settings.json` in the
profile for most, and the module's own file for the rest (`relay.json`,
`guardrails.json`, `consent.json`, `permissions.json`, `shields.json`,
`downloads.json`, `bookmarks.json`, `passwords.json`).

## Appearance

Dark by default. *View › Appearance* (or Settings) switches to Light or Match system; the
choice is kept in `settings.json` in the profile. Pages see it as
`prefers-color-scheme`. Under WSL, *Match system* follows Linux's setting, not
Windows'.

## History

Pages you visit in your own tabs are kept in `history.json` in the profile
(title, address, number of visits, last visit). Pages that Claude sessions open
in their tab groups are not, nor are tabs while you have handed them to a
session. Typing in the address bar suggests pages from it, ranked by how often
and how recently you visited them; the arrow keys move through them, Enter
opens one, Esc closes the list. The first row says what Enter does: an address
you have visited is completed inline as selected text (typing on replaces it,
Backspace removes it), anything else that is not an address is searched for.
Your own open tabs that match are offered as *Switch to tab*. *History* (`Ctrl+H`, or the clock in the
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

Signing in to Google works in Loui. Google refuses a browser that claims to
be one it is not; almost everywhere Loui leaves its own name and Electron's
out of its user agent (sites that look for them serve a broken page), which
is exactly such a claim, so on Google's sign-in pages a tab carries the full,
true one instead (`src/main/identity.js`). This is Google's decision to make
and may change; if it stops working, the list below is the way round.

For a site that will not work in Loui:

- *Open in Brave* (right-click a tab, or the File menu) hands the page's
  address to Brave (or, without Brave, the system's default browser).
- Sites on a list in *File › Settings* (empty to begin with)
  are sent to Brave when one of your tabs opens them, and the tab says so, with
  a link that takes the site off the list. That happens when you had a hand in
  it (you typed the address, or clicked or typed in the tab in the last few
  seconds); a page that goes there by itself, and any page in a private
  window, gets a note with a link that sends it to Brave instead. Claude's
  tabs don't open them at all,
  and a session is told to ask you; Claude never makes Loui open another
  program.

## Bookmarks

`Ctrl+D` or the star in the address bar bookmarks the page onto the bookmarks
bar and opens a strip under the toolbar to rename it, change its address or
put it in a folder; on a page that is already bookmarked they edit its
bookmark. The bar appears with the first bookmark (`Ctrl+Shift+B` shows or
hides it) and holds bookmarks and folders; a folder opens as a menu, what does not fit goes under », and
*Other bookmarks* sits at the right end. Right-click the bar for *Add folder*,
*Edit*, *Delete* and the rest. *Bookmarks* (`Ctrl+Shift+O`) lists them all in
their folders, with search. Bookmarks come first in address bar suggestions,
above pages from history. *Bookmarks › Import bookmarks…* reads the file that
Brave, Chrome, Edge or Firefox export (Brave: *Bookmarks › Bookmark manager ›
⋮ › Export bookmarks*): their bar goes onto the bar, everything else into
*Other bookmarks*, and importing the same file twice adds nothing. Bookmarklets
(`javascript:` addresses) are left out. They are kept in `bookmarks.json` in
the profile. Claude sessions have no tool that reads or changes them.

## Command palette

`Ctrl+K` opens one search box over everything: open tabs (yours and each
Claude session's, labelled with the session), bookmarks, history, every
command in the menus with its shortcut and on/off state, what the tab's
right-click menu offers for the tab on screen (*Sleep this tab now*, *Keep … awake*,
*Open in Brave*), turning Shields off or on for the site, and *Ask Claude*,
which sends what you typed to the Claude panel about the page you are on.
Matching is fuzzy (`zoin` finds *Zoom in*, the matched letters lit up). Arrows
move, `Tab` jumps to the next group, `Enter` opens, `Esc` closes and gives the
keyboard back. With nothing typed it shows your recently used commands, then
the open tabs; recent commands also win ties. `Ctrl+Shift+A` searches open tabs only,
as in Brave. Commands run exactly as their menu items do, since they are read
from the menu each time (`src/main/palette.js`). Only you can open it: keys a
Claude session presses never reach Loui's shortcuts, and it has no tool.

## Passwords

When you sign in to a site in one of your own tabs, a strip above the page
offers *Save password for <site>?* (Save, Never for this site, Not now), or to
update the password if it changed. It asks only once the sign-in went through:
the page moved on to one without a password field, or the field went away.
On a page whose address has saved logins, a key shows in the address bar; its
menu lists the accounts, and choosing one fills the username and password.
Nothing is ever filled when a page loads, only when you choose. *View ›
Passwords* lists them, shows one for 30 seconds, copies one (the clipboard is
cleared 30 seconds later), edits and deletes, and imports the CSV that Brave
or Chrome export (Brave: *Settings › Autofill and passwords › Password manager
› ⋮ › Export*). Delete that file afterwards: it holds every password
unencrypted, and Loui offers to delete it for you.

They are kept in `passwords.json` in the profile. Each password and each
username is encrypted on its own with the system's protection for app secrets
(DPAPI on Windows, the Keychain on macOS, GNOME Keyring or KWallet on Linux);
site addresses are kept readable, so the key can show without decrypting
anything. Without that protection (Linux without a keyring), passwords are off
and nothing is written.

Logins match by exact origin: one saved on `accounts.example.com` is not
offered on `example.com`, and one saved on an `https` page is never offered on
`http`. Only the page itself is filled, never a frame inside it, and never a
field that can't be seen.

**What this protects against, and what not:**

- *Claude sessions* have no tool that reads, lists, fills or saves passwords.
  Their tabs, including tabs you handed over, get no key, no offer and no
  fill. The Claude panel can't fill either: only your click in the key's menu
  (a native menu no page and no Claude can open) fills. The page script that
  notices sign-ins runs only in your own tabs, in an isolated world of its
  own, and its reports never reach the console history tools read. Snapshots
  show a password field's value as `••••`.
- *Pages:* a page can't ask for a fill, and an injected or hidden form gets
  nothing on load. But once a password is in a page, the page's own scripts
  can read it, and so can `evaluate`, which runs in the page. So a password
  you fill in a tab you then hand to a session, or that the panel works in, is
  readable from there: fill and sign in yourself, then hand the tab over.
- *Someone with your disk or a backup* gets ciphertext. *Programs running as
  you* can ask the system to decrypt, as they can for Chrome's and Brave's
  passwords; Loui does not defend against malware on your account.

## Reader view

When a page in your own tabs reads as an article, a book appears in the
address bar (or View › Reader view, F9). It shows the article alone, in
Loui's type and colours, dark or light with the appearance, with controls
at the top for text size, column width and serif or sans type; they are kept
in `settings.json`. Reader view is a page in the tab's history: Back (or the
book, or *Original page*) returns to the page, Forward to the article. The
address bar keeps the article's address, with the book lit.

The article is found by Mozilla's Readability (`@mozilla/readability`, the
library behind Firefox's reader view), run with `src/page/reader.js` in an
isolated world on a copy of the page, and copied through an allow-list: text
and structure, links and images over http(s), nothing else (no scripts,
handlers, styles, frames or forms). It is served from Loui's own
`loui-reader:` scheme, which has an opaque origin (no storage, no cookies),
no bridge, and a policy that runs no scripts and cannot be framed. Articles
are kept in memory only; after a restart a reader entry in a tab's history
links to the page instead.

## Start page

A new tab, a new window, and Loui itself when there is nothing to restore
open on the start page: Louis, a box that points at the address bar (a click
on it, or a letter typed on the page, moves the keyboard to the address bar
with the letter, where the suggestions and completion are; when Loui starts
the address bar has the keyboard already), the eight sites you visit most
(from history, one tile per site with its icon once a tab has shown it, most
visited first; not the search engine, nor a site you went to once; the × on a
tile takes that site off the page, kept in `"startHidden"`, and the page that
follows offers *Undo*), the bookmarks bar's bookmarks while the bar is hidden,
the weather with the date, a few headlines, and how many Claude sessions are
open.
The address bar stays empty, the tab is called *New tab* and carries Louis as
its icon. Back returns to it like any page; it sleeps, wakes and is restored
like one.

*Settings › Start page* chooses what new tabs open with (`"newTab"`:
`"start"`, `"blank"`, or `"address"` with `"newTabAddress"`) and switches each
part on or off (`"startTiles"`, `"startWeather"`, `"startNews"`).

- **Weather** comes from [Open-Meteo](https://open-meteo.com), which needs no
  key. The place is a name you type in Settings, looked up once and kept as
  coordinates (`"weatherPlace"`, `"weatherAt"`); Loui never asks where the
  computer is. Settings says which place the name was taken to mean, and
  *Not this one?* lists the others of that name. `"weatherUnits"` is `"f"` or
  `"c"`; until it is chosen, Fahrenheit only where the system's region uses
  it. When the service does not answer, the last reading stays (in the units
  asked for, with its time) beside *Try again*.
- **News** is the first headlines of the feeds in `"newsFeeds"` (RSS or Atom;
  Google News by default), read by a small parser of Loui's own: titles,
  sources and dates as plain text, links only if they are http or https. An
  address added in Settings is read once first, and not listed if it has no
  headlines; a few well-known feeds, in English and Spanish, are a press away.
- Loui itself fetches both, from the main process: no tab's session is
  involved and no cookies go. They are kept in memory (weather 30 minutes,
  news 15), asked for only when a start page is shown, and a failed fetch is
  tried again after three minutes. A start page waits at most a second and a
  half for them; one that is late shows on the next new tab.

The page is Loui's own, served under `loui-start:` the way reader view is
(`src/main/startpage.js`): an opaque origin, no bridge, and a policy that runs
no script and loads nothing from the web, so its box and its × are a plain
form and plain links that the main process catches. Because it lists the
sites you visit, only your own tabs are ever served it: each request is
checked against the tab that makes it, so a session's tab, a frame or a fetch
gets nothing; no page can send a tab there, and a session's `navigate`
refuses the scheme. A tab you hand to a session while it is on the start page
is given a new blank page first, with the start page gone from its history.
A session's new tabs, and the Claude panel's, are blank as before. In a
private window the start page shows no history and no bookmarks: Louis, the
box, what private windows keep and do not keep, and the weather and news.

## When a page can't be opened

The tab explains what went wrong in a sentence or two, with *Try again*. The
address bar keeps the address that failed, and *Try again*, Reload and Back
all work on that address. When the network is down or the address doesn't
exist, Louis (the husky in the icon) is there too: take him for a walk and
pick up after him before the lawn fills up. The best score is kept in
`game.json` in the profile. When the connection comes back the page reloads by
itself, or, if you have started playing, offers to. The game stops whenever
its tab is not on screen, and Louis sits still if the system asks for reduced
motion.

A site whose certificate can't be verified (a box or dev server of your own
with a self-signed one) has *Advanced › Open anyway* on that page, in your own
tabs only. Loui then accepts that one certificate for that site until you quit
(`src/main/certs.js`; nothing is written down) and marks the address bar *Not
secure* while you are there. Claude sessions' tabs are never let through, and
a press by Claude does not count: only your own keys or mouse in the tab, and
not within ten seconds of the Claude panel working in it. A page whose process crashed gets the same
page, saying so, with *Reload*.

The page is drawn into Chromium's own error document (`src/ui/errorpage.*`,
`src/ui/louis.js`), which has an opaque origin: no bridge, no storage, no
cookies, and history does not record it.

## Voice

Both are in the Claude panel, for you alone: no tool, Claude session or web
page can start the microphone, read what you said, or make Loui speak, and a
private window has neither.

- **Reading replies aloud.** The speaker in the panel's head turns it on
  (kept as `"readBack"` in `settings.json`). Claude's replies are then read by
  the system's voices, a sentence at a time as they arrive: the prose only, not
  the steps; a code block is just called "code block", and of an address only
  the site is said. It stops at once when you press Stop, send a message, start
  dictating, start a new conversation, turn it off, or press `Esc` in the
  panel. While it talks the speaker is filled, and pressing it silences that reply
  without turning reading off. `"readBackVoice"` (a voice's name, as Windows
  lists it under *Settings › Time & language › Speech*) and `"readBackRate"`
  (0.5 to 3, 1 is normal) choose the voice and its speed. With several windows
  open, the one you were in last does the reading.
- **Settings › Claude › Voice** has all of it: reading aloud, the voice (the
  system's, listed by the main window) and its speed with *Play sample*,
  dictation, the languages to tell apart, and the speech model (*Remove*
  deletes it).
- **Dictation.** The microphone beside *Send*: press it, talk, press it again
  (or `Esc`). What you said goes into the message box where the cursor is,
  for you to read, change and send; it is never sent by itself. Holding
  `Ctrl+Shift+Space` while the panel has the keyboard does the same for as
  long as you hold it. While you talk the words so far show above the box.
- **Where the listening happens.** On this machine. Chromium's own speech
  recognition needs Google's servers and keys, and its on-device mode needs
  language packs that only Chrome can install, so Loui runs a small Whisper
  model (`Xenova/whisper-base`, multilingual, 8-bit weights, 77 MB) with
  transformers.js on WebAssembly, in a hidden page of its own
  (`src/ui/voice-page.js`). The first press of the microphone asks, in place,
  and then downloads the model from huggingface.co into `voice/` in the
  profile, with the progress on the button (a press meanwhile cancels it and
  removes what had arrived); the files are checked against fixed hashes, and after that
  dictation works offline. The hidden page can make no request except for its
  own files, so the sound cannot leave the machine, and it is never written to
  disk. Loui decides between the languages in `"dictationLanguages"` (default
  `["en", "es"]`; one language skips the deciding and is a little faster).
- **What it costs.** About three seconds to write down five seconds of
  speech on a four-core laptop. Whisper is hungry while it works: the hidden
  page holds about 1.4 GB, so it exists only while you dictate and closes half
  a minute after the last use, which gives all of it back (it loads again while
  you speak the next time). `"dictation": false` in `settings.json` removes
  the microphone button altogether.
- **Windows' own dictation** (`Win+H`) types into the message box too, and
  needs none of this. (Debian has no counterpart; see *Debian* for what voice
  needs there.)
- **For whoever builds it.** transformers.js also depends on
  `onnxruntime-node` and `sharp`, native packages for Node that Loui never
  loads (only the browser bundle and one WebAssembly file are used, and only
  those are packed: see `build.files`). `overrides` in `package.json` swaps
  both for a small package that is in the tree anyway, so an install fetches
  no native binaries. The model test is skipped unless `LOUI_TEST_VOICE=1` is
  set (`LOUI_VOICE_DIR` points it at a model already downloaded).

## Layout

```
src/shared/tools.js   the tool list (relay and panel both advertise it)
src/main/main.js      window, menu, requests from the window chrome
src/main/tabs.js      views, tab groups, console and network history, device sizes
src/main/sessions.js  sessions and their groups, take over, hand-over
src/main/prompts.js   sessions' questions to the user, one at a time in the tab row
src/main/consent.js   asking before a new session first uses the browser (consent.json)
src/main/activity.js  the activity log: what each session did, kept after it ends (activity/)
src/main/restore.js   your tabs across restarts (tabs.json), reopening closed tabs
src/main/actions.js   what each tool does
src/main/link.js      the connection out to the relay
src/main/rpc.js       local control socket, used by the tests (off otherwise; `"localSocket": true` in settings.json serves it)
src/main/chat.js      the Claude panel (Agent SDK), and whether Claude Code is signed in
src/main/updater.js   updates for installed copies (GitHub Releases)
src/main/downloads.js downloads: where they are saved, the list, pause and resume
src/main/permissions.js  camera, microphone, location, notifications, screen: asking and remembering
src/main/history.js   history: what the user visits in their own tabs (history.json)
src/main/suggest.js   address bar suggestions: their sources, and the list in front of the page
src/main/hints.js     Loui's notes in front of the page: how to leave full screen, a tab's hover card
src/main/requests.js  the one onBeforeRequest listener: the relay guard first, then Shields
src/main/shields.js   Shields: blocking, hiding ad boxes, the per-site switch, list updates
src/main/shields-update.js  downloads the lists and builds the engine, in a process of its own
src/main/search.js    the search engine for the address bar
src/main/brave.js     Open in Brave, and the sites that open there instead of in Loui
src/main/print.js     printing and Save as PDF
src/main/bookmarks.js bookmarks: the bar's folder menus, import, bookmarks.json
src/main/errorpage.js the page shown when a page can't be opened or has crashed (and Louis's walk)
src/main/certs.js     certificates the user accepted for this run ("Open anyway")
src/main/passwords.js passwords: the encrypted store, offers to save, filling, import
src/main/taskmanager.js  the task manager window: memory and CPU per tab and process
src/main/pip.js       watching a session in a small window: its tab's frames, scaled down
src/main/default-browser.js  links from other apps (command line, second launch), Default apps
src/main/reader.js    reader view: the check, the loui-reader: page and its settings, read_article's text
src/main/startpage.js the start page new tabs open with: the loui-start: page, who is served it, its settings
src/main/startfeeds.js  the start page's weather (Open-Meteo) and news (RSS/Atom), fetched and kept by the main process
src/main/settings-window.js  the Settings window: every setting, each driven through the module that owns it
src/main/voice.js     voice: the read-aloud setting, the speech model's download, the hidden page that recognises speech
src/page/lib.js       runs inside each page: outline, element lookup, pointer, picker
src/page/passwords.js runs in your own pages only: notices sign-ins, fills on request
src/page/reader.js    with Readability, in an isolated world: finds the article, cleans it, as text
src/ui/               tab strip, toolbar, panel
src/ui/voice.js       the panel's speaker and microphone: reading replies aloud, recording, putting the words in the box
src/ui/account.js     the panel's account card: sign in to Claude, check again, what to install
src/ui/voice-page.js  the hidden page: Whisper through transformers.js, served from loui-voice://app/
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
- Keys a session presses go to its page only: Loui's own shortcuts (`Ctrl+W`,
  `Ctrl+D`, ...) ignore them, since those act on the tab the user has on screen.
- Sites get clipboard-write, fullscreen and pointer lock without asking. For
  the camera, microphone, location, notifications and screen sharing, Loui asks
  you in a strip above the page, naming the site by its address; an answer
  lasts until you leave the page unless you tick *Remember for this site*
  (screen sharing is asked every time). *View › Site permissions* lists what
  is remembered and forgets it. Tabs in a Claude session's group, including
  tabs you handed over, are refused without asking. Every other permission is
  refused.
- Loui's own pages ask for nothing except the microphone, which only a normal
  window's chrome gets, for dictation. The page that recognises speech runs in
  a session of its own that answers only `loui-voice://app/` addresses and
  cancels every other request.

## Not here yet

- iPhone and iPad app (needs an Apple Developer account and a Mac to build).
- Extensions.
