<p align="center">
  <img src="website/public/logo.svg" width="96" height="96" alt="Blockwise logo: two stacked blocks">
</p>

<h1 align="center">Blockwise</h1>

<p align="center">
  <strong>Plan your week in blocks. Get through it one block at a time.</strong><br>
  For Mac, Android, Nextcloud and the browser · open source (AGPL-3.0) · no account, end-to-end encrypted sync
</p>

Plan your commitments (Thesis, Work, Running…) as blocks in your calendar,
work through your tasks block by block, and see where your time goes.

- **Commitments** are what you give time to. Each has its own calendar, and
  every event in it is a **block** of time for that commitment.
- **Tasks** form a queue per commitment, with subtasks and estimates
  (`Draft chapter 45m`). Each block takes tasks from the top until their
  estimates fill it; what you don't finish moves to the next block.
- **Notes** per commitment, in Markdown, with checklists you can tick.
- **Tracking**: press play to track time, with an optional Pomodoro mode and a
  reminder before a block ends.
- **Done** shows your week on a timeline: planned blocks, tracked time, and
  what you checked off. **Time** shows hours per commitment against weekly
  goals, with CSV export.
- Works **offline** on your devices and syncs when it can. If two devices
  change the same thing, the later change wins, field by field.
- **Backups**: Settings → Your data exports everything to one file (encrypted
  with a passphrase if you like) and imports it on any of the apps, merged
  like a sync.

English and Italian.

## The apps

| | Folder | What it is |
|---|---|---|
| **Nextcloud** | [`nextcloud/`](nextcloud) | A Nextcloud app: the web interface, the sync server for the other apps, and calendars in Nextcloud Calendar. |
| **Android** | [`android/`](android) | Blockwise on your phone, Material 3. Works on its own (no account, the built-in calendar); optionally syncs with Nextcloud (blocks from the phone's calendars, via DAVx⁵) or through Dropbox / Google Drive, end-to-end encrypted. |
| **Mac** | [`mac/`](mac) | A Mac app with a menu bar timer and notifications. Syncs with Nextcloud, or end-to-end encrypted through **Dropbox** or **Google Drive**, or keeps your data on the Mac only; blocks come from Apple Calendar. |
| **Browser** | [`website/app/`](website/app) | Blockwise as a web page, with no server of its own: the data stays in the browser (encrypted in IndexedDB), and optionally syncs end-to-end encrypted through **Dropbox**. Published with the website. |

All of them show the same interface: it is written once, in `nextcloud/js` and
`nextcloud/css`, and copied into the Android, Mac and browser apps when they
are built. The browser app also reuses the Android app's setup and bridge
(`android-bridge.js`, `setup.js`) and the Mac app's drive code (`drives.js`).

## Installing

Ready-made builds come from GitHub Actions on every push to `main`: the
releases **mac-latest** (`Blockwise-mac.dmg`), **latest** (`Blockwise.apk`) and
**nextcloud-latest** (`blockwise-nextcloud.tar.gz`). The [`website/`](website)
folder is the website (Astro, static): features, a guide, privacy and
security, and downloads, in English and Italian; it also serves the browser
app at `/app/`.


**Nextcloud** (version 32 to 35): copy the `nextcloud` folder into your
server's `apps` folder **named `tracker`** (the app's id), then enable it:

```sh
cp -r nextcloud /var/www/nextcloud/apps/tracker
sudo -u www-data php occ app:enable tracker
```

**Android** (8.0 or newer): download `Blockwise.apk` from the
[latest release](../../releases/latest), open it on your phone and allow the
installation. Log in with your Nextcloud address.

**Mac** (Apple silicon): build it, see [`mac/README.md`](mac/README.md).

## Building

```sh
# Android: APK in android/app/build/outputs/apk/
cd android && ./gradlew assembleDebug

# Mac: Blockwise.app in mac/dist/mac-arm64/
cd mac && npm install && npm run build
```

Every push to GitHub runs the tests and builds the Android app; see
[`.github/workflows`](.github/workflows). Release builds are signed with a key
kept in the repository's secrets (`ANDROID_KEYSTORE_B64`,
`ANDROID_KEYSTORE_PASSWORD`); without them the build is a debug build.

## Tests

```sh
node nextcloud/tests/markdown.test.js          # Markdown parser (no server needed)
node nextcloud/tests/filesync.test.js          # encrypted drive sync (no server needed)
node nextcloud/tests/backup.test.js            # backup export and import (no server needed)
node mac/test/drives.test.js                   # Dropbox and Google Drive, stand-in servers
cd android && ./gradlew :core:coreTest         # Android logic
# With a Nextcloud test server on localhost:8080 (users admin and bob):
node nextcloud/tests/sync.test.js
node nextcloud/tests/engine.test.js
node nextcloud/tests/notes.test.js
```

## Security

See [SECURITY.md](SECURITY.md) for how your data is protected and how to report
a problem.

## License

[AGPL-3.0-or-later](LICENSE). © 2026 amecs-gh.
