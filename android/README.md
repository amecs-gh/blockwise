# Blockwise for Android

Blockwise on your phone, like the Mac app. It works on its own (no account,
nothing synced, the built-in calendar), or syncs with your Nextcloud, or with
your Mac and other phones through Dropbox, Google Drive or OneDrive (end-to-end encrypted):

- **The app:** Blockwise's pages (Now, Tasks, Done, Time, Settings, each
  commitment) with a bottom tab bar and your commitments as chips on top. It's
  the same interface code as in Nextcloud and on the Mac, so all three stay identical.
- **Timer notification:** while you track time, an ongoing notification shows
  the commitment and a running clock (a countdown in Pomodoro mode), with a **Stop** button.
- **Reminders:** before a block ends and for Pomodoro breaks. At the long break,
  tracking stops on its own, like on the web and the Mac.
- **Calendar** opens your phone's calendar app on that day; the **person icon**
  shows your account (notifications on/off, sync with Nextcloud, log out).

Needs Android 8 or newer. To sync: Blockwise 0.5.1 or newer on your Nextcloud (the Nextcloud app's folder and id stay `tracker`).

## Build and install

You need the Android SDK once. Pick one of three ways:

**A. Android Studio (easiest)**

```bash
brew install --cask android-studio
```

Open Android Studio, choose **Open**, and pick `~/Projects/blockwise/android`. Let it
finish "Gradle sync" (the first time it downloads the Android SDK, a few GB).
Then either:

- plug in your phone with **USB debugging** on (Settings → About phone → tap
  "Build number" 7 times → Developer options → USB debugging) and press ▶ Run, or
- **Build → Build App Bundle(s) / APK(s) → Build APK(s)**, then copy
  `app/build/outputs/apk/debug/app-debug.apk` to the phone and open it
  (allow "install unknown apps" for your file manager once).

**B. Terminal only**

```bash
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
cd ~/Projects/blockwise/android
./gradlew :core:coreTest assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk   # phone connected with USB debugging
```

**C. On GitHub (no SDK on your Mac)**

Push this folder to a private GitHub repository. The workflow in
`.github/workflows/android.yml` builds the APK on every push and publishes it
under **Releases → latest**.

With your signing key as two repository secrets (Settings → Secrets and
variables → Actions: `ANDROID_KEYSTORE_B64`, the keystore in base64, and
`ANDROID_KEYSTORE_PASSWORD`), it builds the **release** version: signed with
your key, not debuggable, and every update installs over the previous one
(keeping your login). Without them it builds the debug version. Keep a backup
of the key: Android only installs updates signed with the same key.

`./gradlew` and Android Studio first copy Blockwise's interface from
`../tracker` (when that folder exists), like `npm start` does for the Mac app.

## First start

Choose **Start on this phone** to use Blockwise without any account: your data
stays on the phone, encrypted, and blocks live in Blockwise's built-in calendar.
You can sync later (person icon → **Set up sync**) and your data goes along.
With Nextcloud, blocks planned on the phone stay on it (Nextcloud has its own
calendars); with a drive, they go along too.

**Dropbox, Google Drive or OneDrive:** tap it, allow Blockwise in your browser, then come
back and choose a passphrase (or enter the one from your Mac). Everything is
encrypted with it on the phone before it goes to the drive; Blockwise only sees
its own folder there (Dropbox and OneDrive: Apps/Blockwise; Google Drive: hidden app data).
The drive login and the key are kept encrypted by the Android Keystore. You
can also choose **Sync without encryption** (no passphrase; the drive's
provider can read the files), with a warning first.

With a drive, other devices' changes arrive by themselves: while the app is open
it watches the drive (Dropbox tells at once; Google Drive is asked every 20
seconds), and while it's closed Android lets it check about every 15 minutes.
Only when something changed does it sync, in an invisible page of its own, so
the timer notification and reminders follow what you do on your Mac. The
drives are offered when the build has the app ids (the repository variables
`DROPBOX_APP_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`,
same as the Mac app; setting them up: mac/README.md).

With Google Drive or OneDrive, Settings → **Blocks in Google Calendar / Outlook**
puts your blocks in that account's calendar, a calendar per commitment; plan
there or here, on every device. What Blockwise may touch there, and why it is
limited to its own calendars: mac/README.md, "Blocks in Google Calendar or Outlook".

Or choose **Sync with Nextcloud**, enter your Nextcloud address (your Tailscale
name works) and tap **Log in**. Nextcloud's login page opens: log in and tap **Grant access**. The app gets its
own app password (visible in Nextcloud under Settings → Security, where you can
revoke it). Allow notifications when asked.

For reminders on the minute, allow exact alarms: person icon → **Allow exact
reminders**. Without it, Android can deliver them a few minutes late.

If the Nextcloud app is also on your phone, it shows Blockwise's server-side
reminders too. Turn one of them off if you get both: person icon → Notifications.

## Security

- The app password is encrypted with a key in the **Android Keystore** (it never
  leaves the phone's secure hardware). Backups and device transfer are turned
  off for the app's data. If the Keystore fails, the password is kept in memory
  only and never written down unencrypted.
- **https only**, with the system's certificate authorities. Plain http only to
  this phone and Tailscale names (`*.ts.net`), where the tunnel is encrypted.
  Redirects are never followed with the password attached. The login flow's URLs
  are pinned to the address you entered.
- The interface runs from the app's own files in a WebView that can't navigate
  anywhere else, open windows, or read files. It reaches Nextcloud only through
  the app, and only **Blockwise's own API** (never WebDAV, your files, or other
  endpoints). Links open only if they're `https`/`http`, in your browser.
- Nextcloud's login page runs without access to the app; its cookies are deleted
  afterwards.
- The lock screen shows "Tracking" and the clock, not what you work on.

## How it works

| Path | What it does |
| --- | --- |
| `core/` | Plain Java, no Android: address rules, API filter, reminders and Pomodoro (`./gradlew :core:coreTest`) |
| `app/.../MainActivity.java` | The window: WebView with the interface, account sheet, login |
| `app/.../Bridge.java` | What the page may ask the app to do |
| `app/.../Nextcloud.java` | Login flow v2 and the Blockwise API (app password, Basic auth) |
| `app/.../Store.java` | Login and settings; the app password encrypted with the Keystore |
| `app/.../Tracking.java` | Timer notification, reminders, scheduled checks |
| `app/.../LoginActivity.java` | Nextcloud's login page |
| `app/src/main/assets/` | The page: `app.html`, `android-bridge.js`, `android.css`; `web/` is copied from `../tracker` |
| `test/ui.test.js` | The page at phone size in Chromium against a Nextcloud test server |
| `tools/android_stubs.py` | Type-checks the app's Java without the Android SDK |

## Local-first

Blockwise runs on the phone: the interface talks to the engine (`web/engine.js`, from the
Nextcloud app's `js/engine.js`), which keeps your data on the phone and syncs with
Nextcloud (`/api/sync`, Blockwise 0.4.0 or later) whenever it can. Per field, the latest
change wins; deleted stays deleted.

- **Your data on the phone** is encrypted with its own Android Keystore key, in the
  no-backup folder. Logging out removes it; another account starts empty.
- **Blocks** come from the phone's calendars (your Nextcloud calendars, synced by
  DAVx⁵), so they work offline, and "Plan a block" adds one there. Calendars the phone
  doesn't have are read from the server while online.
- **The app password** reaches only `GET/POST sync`, `GET state` and `GET blocks`
  (`core/ApiGuard`).
- **Stop in the notification** works offline: the change is kept (encrypted), sent to
  the server when possible and handed to the engine when the app opens.
