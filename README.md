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
  order, Purchase, Checkout, Transfer, Subscribe, Order, Book, Reserve,
  Upgrade, Send, Post, Publish, Share, Reply, Delete, Remove account,
  Unsubscribe, Discard, Empty trash (and Pagar, Comprar, Reservar, Suscribirse,
  Enviar, Publicar, Compartir, Responder, Eliminar, Borrar, Descartar,
  Transferir, Confirmar compra), whether it is a button or anything else that
  takes clicks; Confirm or Yes in a dialog about paying or deleting;
  submitting a form that holds card, password or one-time-code fields (by a
  click, or Enter); Enter in a chat box with a Send button beside it; opening
  a site on your list; and `evaluate` on a page with card or password fields.
  A click is judged on what it will land on (something laid over the element
  counts), and again just before it is sent.
- **What a script of Claude's does:** a click, submit or Enter that `evaluate`
  sends to such a control is stopped in the page and asked about, then let
  through if you allow it; so is what a `<select>` sets off when
  `select_option` changes it, and a form either of them posts.
- **What the page does by itself:** while a session acts in a tab, and for ten
  seconds after, any POST, PUT, PATCH or DELETE from that tab carrying a card
  number, password or one-time code is held until you answer, however it
  started (a "Next" button whose script submits a payment form,
  `form.submit()`, `fetch`). So is the tab going to a site on your list by a
  script, a form or a redirect.
- **Not caught:** a payment or deletion whose request carries none of those
  (an order placed with a saved card through an API call, a delete over
  `fetch`) unless the control that started it is named like one; a control
  with a name outside the list; a page acting more than ten seconds after the
  session's last action; WebSockets.
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
`ask_user_to_pick`, and `devices` (list your browsers, or move to another).
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
  Chromium switch. (On Linux, links given on the command line open too.)
- The Claude panel runs Claude Code: an installed `claude.exe` if there is
  one, otherwise Claude Code inside WSL (`wsl.exe`), with your WSL login.
- **Updates.** An installed copy checks GitHub Releases shortly after launch and
  every hour, downloads a new version in the background, and installs it
  when Loui quits. *Restart to update* in the toolbar (and the Help menu)
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
you can pause, resume or cancel them, try a cancelled or failed one again,
open a finished file or show it in its folder, and remove single rows. A
program, script or shortcut says *Run…* instead of *Open* and asks once more
in its row. A running download shows its speed and time left, and *Stalled*
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
  (Windows); the downloads folder and *Ask where to save each file*.
- **Tabs**: vertical tabs, the bookmarks bar, how long before a background
  tab sleeps (or never), and the sites that are never put to sleep.
- **Search**: the search engine, or an address of your own.
- **Privacy and security**: sites with Shields off and the filter lists
  (*Update now*), remembered site permissions, sites that open in your other
  browser, and what pop-ups and private windows do.
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
a press by Claude does not count. A page whose process crashed gets the same
page, saying so, with *Reload*.

The page is drawn into Chromium's own error document (`src/ui/errorpage.*`,
`src/ui/louis.js`), which has an opaque origin: no bridge, no storage, no
cookies, and history does not record it.

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
src/main/bookmarks.js bookmarks: the bar's folder menus, import, bookmarks.json
src/main/errorpage.js the page shown when a page can't be opened or has crashed (and Louis's walk)
src/main/certs.js     certificates the user accepted for this run ("Open anyway")
src/main/passwords.js passwords: the encrypted store, offers to save, filling, import
src/main/taskmanager.js  the task manager window: memory and CPU per tab and process
src/main/pip.js       watching a session in a small window: its tab's frames, scaled down
src/main/default-browser.js  links from other apps (command line, second launch), Default apps
src/main/reader.js    reader view: the check, the loui-reader: page and its settings, read_article's text
src/main/settings-window.js  the Settings window: every setting, each driven through the module that owns it
src/page/lib.js       runs inside each page: outline, element lookup, pointer, picker
src/page/passwords.js runs in your own pages only: notices sign-ins, fills on request
src/page/reader.js    with Readability, in an isolated world: finds the article, cleans it, as text
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

## Not here yet

- iPhone and iPad app (needs an Apple Developer account and a Mac to build).
- Extensions.
