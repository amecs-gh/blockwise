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
| **Nextcloud** | With the Blockwise app on your Nextcloud (0.6.0 or newer) and the Android app | Nextcloud's calendars |
| **Dropbox** | Through `Apps/Blockwise` in your Dropbox, end-to-end encrypted | Apple Calendar |
| **Google Drive** | Through Blockwise's hidden app folder in your Drive, end-to-end encrypted | Apple Calendar |
| **This Mac only** | None; connect a sync later and your data comes along | Apple Calendar |

**Calendar:** the sidebar's **Calendar** shows your blocks: with Nextcloud,
they are events in your commitments' Nextcloud calendars (changes show in
Nextcloud Calendar and on your phone; needs a connection). Without Nextcloud,
they are in Blockwise's **built-in
calendar** (sidebar → Calendar): day, week and month, drag on the grid to plan a
block, drag a block to move it, drag its lower edge to change its length,
repeats (every day, weekday, week, 2 weeks, month, with an end date) and "this
block only / all future blocks" like Apple Calendar. Click a block to see the
tasks and subtasks planned for it, tick them off there, or start the timer.
Keys: ← → to move, T today, D W M for day, week, month, N for a new block.
Built-in blocks sync with your data (through Dropbox or Google Drive) and need
no calendar access.

Prefer **Apple Calendar** (iCloud, Google, Exchange, Nextcloud via CalDAV)?
Settings → Calendar → Apple Calendar. Blockwise explains, then macOS asks for
calendar access (it only offers full access). Each commitment gets a calendar
and your built-in blocks are copied there, repeats included. Switching back
copies the events of your commitments' calendars (3 months back to a year
ahead) into the built-in calendar; nothing is doubled either way, and a block
you changed replaces its old copy.

### Dropbox, Google Drive and OneDrive: end-to-end encrypted

With a drive, Blockwise asks for a **passphrase** (at least 10 characters) the
first time; your other Macs use the same one. Everything is encrypted on your
Mac before it is uploaded (AES-256-GCM, key from your passphrase with
PBKDF2-SHA256, 600,000 rounds). Dropbox or Google see only encrypted files named
`log-…bwx` and a `blockwise.json` with the salt. **Keep the passphrase in your
password manager**: without it nobody, not even you, can read the synced data
(the copy on each Mac stays readable).

If you'd rather not use a passphrase, choose **Sync without encryption** when you
set up the folder. Then the files are plain JSON that Dropbox or Google (and
anyone who gets into that account) can read; your other devices join without a
passphrase. A folder keeps its choice: a device refuses a folder whose
encryption was switched off (or on) after it joined.

Blockwise watches the drive for your other devices' changes and syncs as soon
as one writes: Dropbox tells it at once (it waits on Dropbox's change
notification, which carries no token), Google Drive is asked every 20 seconds
while the window is open and every 2 minutes from the menu bar.

Blockwise can only see its own folder: in Dropbox the app folder, in Google
Drive the hidden app data folder (scope `drive.appdata`), in OneDrive its app
folder (`Apps/Blockwise`, scope `Files.ReadWrite.AppFolder`), not your other files.
OneDrive is checked for changes like Google Drive.

### Blocks in Google Calendar or Outlook

With Google Drive or OneDrive, Settings → **Blocks in Google Calendar** (or
**Blocks in Outlook**) puts your blocks in that account's calendar: each
commitment gets its own calendar there, the built-in blocks are moved to it,
and from then on you plan in Blockwise or in the calendar app, on every device
(each Mac and phone follows; one that hasn't allowed the calendar yet asks).
Switching it off copies the calendar's events (3 months back to a year ahead)
back into Blockwise. Blocks still show offline and changes wait until the
calendar answers.

What this means for your privacy: the titles and times of your **blocks** are
then stored by Google or Microsoft like any calendar event (not end-to-end
encrypted). Tasks, notes and tracked time stay end-to-end encrypted in the drive.

What Blockwise may touch:

- **Google**: the scope `calendar.app.created`, so Google itself only lets
  Blockwise see and change the calendars Blockwise made. You can leave it out
  on Google's consent page; then you're asked again when you switch it on.
- **Microsoft**: Outlook needs `Calendars.ReadWrite`, which Microsoft can't
  limit to some calendars, so it is asked for only when you switch it on, and
  Blockwise limits itself: every calendar it makes carries a hidden mark, and
  the app (not the page) refuses any request to a calendar without that mark,
  any request other than the few calendar requests Blockwise makes, and any
  field in an event other than its title, times and repeat (so it can never add
  attendees or send anything to anyone). Mail and your other files are out of
  reach.

## Set up Dropbox, Google Drive and OneDrive (once, for your build)

Every build needs its own app keys from Dropbox, Google and Microsoft; Blockwise
doesn't ship any. They are not secret (the login uses PKCE), but they are yours.
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

1. Create a project, then APIs & Services → Library → enable **Google Drive API**
   and **Google Calendar API**.
2. OAuth consent screen (Google Auth Platform → Data access): add the scopes
   `https://www.googleapis.com/auth/drive.appdata` and
   `https://www.googleapis.com/auth/calendar.app.created`. Audience: External,
   add yourself as a test user.
3. Credentials (Clients) → Create → OAuth client ID → **Desktop app**. (The
   Android app uses the same client, so create a Desktop app client even if you
   only use the phone.)
4. Copy the client ID into `googleClientId` and the client secret into
   `googleClientSecret` (for desktop apps Google doesn't treat it as secret).

While the consent screen is in "Testing", Google asks you to log in again
every 7 days; publish it (Audience → Publish app) to avoid that. Both scopes
are "non-sensitive", so for yourself no verification is needed; Google may
show an "unverified app" notice you can click through.

**OneDrive and Outlook** (<https://entra.microsoft.com/> → App registrations,
with any Microsoft account; a free Azure account works):

1. New registration → name "Blockwise" → Supported account types: **Accounts
   in any organizational directory and personal Microsoft accounts**.
2. Redirect URI: platform **Public client/native (mobile & desktop)**, URI
   `http://localhost` (exactly; Microsoft accepts any port for it).
3. Authentication → Advanced settings → **Allow public client flows: Yes**. Save.
4. API permissions → Add → Microsoft Graph → Delegated: `Files.ReadWrite.AppFolder`,
   `Calendars.ReadWrite`, `offline_access` (and keep `User.Read`). No admin
   consent is needed for your own account.
5. No client secret: copy the **Application (client) ID** (on Overview) into
   `microsoftClientId`.

The OneDrive folder appears as `Apps/Blockwise` in your OneDrive. Microsoft has no
way to end one app's login from the app; to cut it off, remove Blockwise at
<https://account.live.com/consent/Manage> (personal) or <https://myapps.microsoft.com>
(work or school).

**For the GitHub builds** (Android and Mac): add repository variables (Settings →
Secrets and variables → Actions → Variables) `DROPBOX_APP_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`. The workflows
write them into `providers.json` (see `.github/workflows/android.yml` and
`mac.yml`: `microsoftClientId` must be in the JSON they write).

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
  are sent in headers and bodies, never in URLs. Disconnecting revokes the token
  (Dropbox, Google; Microsoft has none to revoke: remove the app in your account).
- The account's calendar: only the calendar requests Blockwise makes, checked in
  the app; in Outlook only calendars marked as Blockwise's, and events with a
  title, times and a repeat only (see "Blocks in Google Calendar or Outlook").
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
npm test           # reminders, Pomodoro, Dropbox, Google Drive, OneDrive and Outlook (stand-ins)
npm run test:ui    # first-run screen; the whole app against a test Nextcloud on localhost:8080
```
