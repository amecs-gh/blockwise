# Blockwise for Mac

Blockwise as a Mac app:

- **Window** with Blockwise's pages (Now, Tasks, Notes, Done, Time, Settings) in a
  Mac window with a sidebar. **Calendar** in the sidebar opens **Apple Calendar**.
- **Menu bar item** with the running time next to the icon. Click it for a panel
  with the timer, the current block's subtasks to check off, a quick "add
  subtask" field (`Check figures 20m` works like in Blockwise), and a play button
  for each commitment. Right-click for sync, settings, log out and quit.
- **Notifications** before a block ends and for Pomodoro breaks.
- **Works offline.** Your data lives on this Mac; changes sync when you're online.

## Where your data lives

The first time, Blockwise asks where to keep your data. To change it later:
**Blockwise → Log out or switch sync…** (also when you right-click the menu
bar icon). **Switch and take my data** keeps everything on this Mac and sends
it to the sync you choose next; **remove** leaves it only where it is synced now.

| Choice | Sync | Calendar blocks come from |
| --- | --- | --- |
| **Nextcloud** | With the Blockwise app on your Nextcloud (0.5.1 or newer) and the Android app | Nextcloud's calendars |
| **Dropbox** | Through `Apps/Blockwise` in your Dropbox, end-to-end encrypted | Apple Calendar |
| **Google Drive** | Through Blockwise's hidden app folder in your Drive, end-to-end encrypted | Apple Calendar |
| **This Mac only** | None; connect a sync later and your data comes along | Apple Calendar |

**Apple Calendar is optional** (right-click the menu bar icon → **Use Apple
Calendar**). With it, the events in the calendars you link to a commitment are
your planned time blocks, and Blockwise adds the blocks you plan. It shows every
calendar you added to macOS (iCloud, Google, Exchange, Nextcloud via CalDAV).
macOS only offers full calendar access, so Blockwise explains first and asks
only when you turn it on. Without it, everything else works: commitments,
tasks, notes, the timer and your time.

### Dropbox and Google Drive: end-to-end encrypted

With a drive, Blockwise asks for a **passphrase** (at least 10 characters) the
first time; your other Macs use the same one. Everything is encrypted on your
Mac before it is uploaded (AES-256-GCM, key from your passphrase with
PBKDF2-SHA256, 600,000 rounds). Dropbox or Google see only encrypted files named
`log-…bwx` and a `blockwise.json` with the salt. **Keep the passphrase in your
password manager**: without it nobody, not even you, can read the synced data
(the copy on each Mac stays readable).

Blockwise can only see its own folder: in Dropbox the app folder, in Google
Drive the hidden app data folder (scope `drive.appdata`), not your other files.

## Set up Dropbox and Google Drive (once, for your build)

Every build needs its own app keys from Dropbox and Google; Blockwise doesn't
ship any. They are not secret (the login uses PKCE), but they are yours.
Copy `config/providers.example.json` to `config/providers.json` (not committed)
and fill in what you set up. A choice without a key is hidden.

**Dropbox** (<https://www.dropbox.com/developers/apps>):

1. Create app → Scoped access → **App folder** → name it, e.g. "Blockwise".
2. Permissions: tick `files.metadata.read`, `files.content.read`,
   `files.content.write`, then Submit.
3. Settings → OAuth 2 → Redirect URIs: add `http://127.0.0.1:53682/dropbox`.
4. Copy the **App key** into `dropboxAppKey`. (The app secret is not needed.)

While the app is in "development" status, up to 500 Dropbox accounts can use it,
which is plenty for yourself.

**Google Drive** (<https://console.cloud.google.com/>):

1. Create a project, then APIs & Services → Library → enable **Google Drive API**.
2. OAuth consent screen: External, add yourself as a test user, add the scope
   `https://www.googleapis.com/auth/drive.appdata`.
3. Credentials → Create credentials → OAuth client ID → **Desktop app**.
4. Copy the client ID into `googleClientId` and the client secret into
   `googleClientSecret` (for desktop apps Google doesn't treat it as secret).

While the consent screen is in "Testing", Google asks you to log in again
every 7 days; publish it to avoid that (Google may ask you to verify the app first).

## Run it

```bash
cd mac
npm install        # once; downloads Electron (~100 MB)
npm start
```

**Nextcloud:** enter your Nextcloud address (your Tailscale name works) and
click **Log in**. A window with your Nextcloud login opens: log in and click
**Grant access**. The app receives its own app password (shown in Nextcloud under
Settings → Security, where you can revoke it), stored encrypted with your
macOS Keychain.

**Dropbox / Google Drive:** your browser opens; log in there and allow
Blockwise (the app never sees your password). Then choose or enter the passphrase.

## Build the app

Needs Xcode's command line tools (`xcode-select --install`) for the small
Apple Calendar helper.

```bash
npm run build      # creates dist/mac-arm64/Blockwise.app
```

Drag `Blockwise.app` into Applications. It isn't signed with an Apple developer
certificate, only "ad hoc", which is fine for your own Mac. If macOS says the
app is damaged or can't be opened, run:

```bash
xattr -cr dist/mac-arm64/Blockwise.app
```

To start it with your Mac, right-click the menu bar icon → **Open at login**.

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | App, windows, menu bar item, notifications, sync |
| `renderer/web/engine.js` | Your data on this Mac and the Blockwise API, offline (shared with Android) |
| `renderer/web/filesync.js` | Encrypted sync through a drive folder |
| `src/nextcloud.js` | Nextcloud login flow and requests (app password) |
| `src/drives.js`, `src/oauth.js` | Dropbox and Google Drive: browser login (PKCE), files |
| `src/calendar.js`, `helper/` | Apple Calendar (a small Swift helper using EventKit) or Nextcloud's calendars |
| `src/vault.js` | Secrets and your data, encrypted with a key in your Keychain |
| `src/alerts.js` | When to notify, Pomodoro phases, menu bar text |
| `src/preload.js` | Bridge to the windows (they never see passwords or tokens) |
| `renderer/` | The window, menu bar panel and first-run screen |
| `scripts/sync-web.js` | Copies the interface from `../nextcloud` before start/build |

## Security

- Secrets (app password, drive token, sync key) and your data on this Mac are
  stored only encrypted with a key in your Keychain, in files readable by you
  only. Without the Keychain nothing is saved.
- Your passphrase is never stored: only the key made from it, in the Keychain.
- Drive logins: PKCE and a random `state`, answered on `127.0.0.1` only; tokens
  are sent in headers and bodies, never in URLs. Disconnecting revokes the token.
- Files from a drive are checked: each is authenticated (AES-GCM, bound to its
  name), so a changed, swapped or foreign file is refused, not merged.
- Requests and the Nextcloud login use in-memory sessions: no cookies on disk.
  Only `https://` addresses (plain `http://` only for this Mac and Tailscale).
- The windows can only call Blockwise's own API, never open other windows or
  navigate away, and only open web links, in your browser.
- The built app has Electron's fuses set (no "run as Node", no inspector, asar
  integrity checked), so other programs can't use Blockwise's Keychain access.

## Tests

```bash
npm test           # reminders, Pomodoro, Dropbox and Google Drive (stand-in servers)
npm run test:ui    # first-run screen; the whole app against a test Nextcloud on localhost:8080
```
