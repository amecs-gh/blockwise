# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's
**Report a vulnerability** (Security tab → Advisories) to tell the maintainer
privately. You'll get an answer within a week.

## How your data is protected

**Nextcloud app**
- Every request checks that the record belongs to the logged-in user; other
  users' commitments, tasks, notes and calendars can't be read, changed or
  linked to (also through sync).
- Values from devices are checked and limited (types, lengths, sizes, dates;
  clocks more than a day ahead are refused). Errors never reveal server paths.
- The interface builds the page from text only: notes in Markdown are parsed
  into a fixed set of elements, never inserted as HTML; links only open
  `http`/`https` addresses.

**Android app**
- Logs in with Nextcloud's login flow: it gets its own app password, which you
  can revoke in Nextcloud (Settings → Security). The password is encrypted with
  a key in the Android Keystore; your data on the phone with another one.
- The app password can only reach Blockwise's sync endpoints, never your files.
- Only `https`, or `http` to `localhost` and Tailscale names (`*.ts.net`).
- No backups of app data; logging out removes Blockwise's data from the phone.
- Release builds are signed with the maintainer's key, kept only in GitHub's
  secrets, never in this repository.

**Mac app**
- The app password is encrypted with a key in the macOS Keychain.
- The app is built with Electron's security fuses on (no Node from the
  outside, cookie encryption, integrity checks); its pages can only reach its
  own API.

## Supported versions

Only the latest release gets fixes.
