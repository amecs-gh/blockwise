# Blockwise

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

English and Italian.

## The apps

| | Folder | What it is |
|---|---|---|
| **Nextcloud** | [`nextcloud/`](nextcloud) | A Nextcloud app: the web interface, the sync server for the other apps, and calendars in Nextcloud Calendar. |
| **Android** | [`android/`](android) | Blockwise on your phone, Material 3. Your data stays on the phone and syncs with Nextcloud; blocks come from the phone's calendars (Nextcloud calendars via DAVx⁵). |
| **Mac** | [`mac/`](mac) | A Mac app with a menu bar timer and notifications. Syncs with Nextcloud, or end-to-end encrypted through **Dropbox** or **Google Drive**, or keeps your data on the Mac only; blocks come from Apple Calendar. |

All three show the same interface: it is written once, in `nextcloud/js` and
`nextcloud/css`, and copied into the Android and Mac apps when they are built.

## Installing

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

[AGPL-3.0-or-later](LICENSE). Blockwise started from
[TimeManager](https://github.com/te-online/timemanager) by Thomas Ebert
(AGPL-3.0); its clients and projects became commitments linked to calendars.
