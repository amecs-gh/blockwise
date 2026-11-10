# Blockwise for Mac

A Mac app for the **Blockwise** Nextcloud app:

- **Window** with Blockwise's pages (Now, Tasks, Done, Time, Settings) in a Mac
  window with a sidebar: no browser, no Nextcloud page around it. **Calendar**
  in the sidebar (and "Open in Calendar" on a day) opens **Apple Calendar**.
- **Menu bar item** with the running time next to the icon. Click it for a panel
  with the timer, the current block's subtasks to check off, a quick "add
  subtask" field (`Check figures 20m` works like in Blockwise), and a play button
  for each commitment. Right-click for settings, log out and quit.
- **Notifications** before a block ends and for Pomodoro breaks; at the long break
  tracking stops on its own, like in the web app.

Needs Blockwise 0.3.2 or newer on your Nextcloud.

## Apple Calendar

Add your Nextcloud calendars to Apple Calendar once: System Settings → Internet
Accounts → Add Other Account → CalDAV account. Account type "Manual", your
Nextcloud user name, an app password (Nextcloud → Settings → Security → "Create
new app password"), and as server address
`https://<your nextcloud>/remote.php/dav`. Commitment calendars then appear in
Apple Calendar, and blocks you add or move there are picked up by Tracker.

The first time Blockwise opens Apple Calendar on a specific day, macOS asks
whether Blockwise may control Calendar: allow it.

## Run it

```bash
cd ~/Projects/tracker-mac
npm install        # once; downloads Electron (~100 MB)
npm start
```

The first time, enter your Nextcloud address (your Tailscale name works) and
click **Log in**. A window with your Nextcloud login opens: log in and click
**Grant access**. The app receives its own app password (shown in Nextcloud under
Settings → Security, where you can revoke it), stored encrypted with your
macOS Keychain. You stay logged in until you choose **Log out**.

macOS asks once whether Blockwise may send notifications: allow it.

## Build the app

```bash
npm run build      # creates dist/mac-arm64/Tracker.app
```

Drag `Tracker.app` into Applications. It isn't signed with an Apple developer
certificate, only "ad hoc", which is fine for your own Mac. If macOS says the
app is damaged or can't be opened, run:

```bash
codesign --force --deep --sign - dist/mac-arm64/Tracker.app
xattr -cr dist/mac-arm64/Tracker.app
```

To start it with your Mac, right-click the menu bar icon → **Open at login**.
Started that way, it stays in the menu bar without opening the window.

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | App, windows, menu bar item, notifications |
| `src/nextcloud.js` | Login flow and Blockwise API (app password, Basic auth) |
| `src/alerts.js` | When to notify, Pomodoro phases, menu bar text |
| `src/preload.js` | Bridge to the windows (they never see the password) |
| `renderer/app.html` | The window: Blockwise's interface with Mac styling (`desktop.css`) |
| `renderer/web/` | Blockwise's interface code, copied from `../tracker` |
| `renderer/popover.*`, `setup.*` | Menu bar panel and first-run screen |
| `scripts/sync-web.js` | Copies the interface from `../tracker` before start/build |

The window runs the same interface code as the Nextcloud app, so changes there
show up here too: `npm start` and `npm run build` copy it from `../tracker`
first. Requests go through the app with the app password; nothing is loaded from
the web. The app sends the notifications, so the window doesn't.

If you also use the Nextcloud desktop client, it shows Nextcloud's own
notifications. Blockwise's server-side reminders can then appear twice; turn off
**Desktop notifications** in Blockwise's menu if that bothers you.

## Security

- The app password is stored only encrypted with a key in your Keychain
  (`config.json`, readable by you only). Without the Keychain it is kept in
  memory and revoked when you quit.
- Requests and the login page use in-memory sessions: no Nextcloud cookies on disk.
- Only `https://` addresses (plain `http://` only for this Mac and Tailscale).
  Redirects are never followed with the password attached, and the login flow's
  URLs are pinned to the address you entered.
- The windows can only call Blockwise's own API (not WebDAV or other endpoints),
  never open other windows or navigate away, and only open web links, in your browser.
- The built app has Electron's fuses set (no "run as Node", no inspector, asar
  integrity checked), so other programs can't use Blockwise's Keychain access.
  Check with `npx @electron/fuses read --app dist/mac-arm64/Tracker.app`.

## Tests

`npm test` checks the reminder and Pomodoro logic. `test/app.test.js` runs the
real main process with a stand-in for Electron and the real windows in Chromium
against a Nextcloud test server (it expects one on `localhost:8080`).
