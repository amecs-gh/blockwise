# Blockwise website

A static site in English (`/`) and Italian (`/it/`), in a calm Apple-like look,
light and dark, plus Blockwise itself in the browser at `/app/`. No cookies,
no scripts on the pages, nothing loaded from other sites: upload this folder
as it is to any static host (Netlify, Cloudflare Pages, GitHub Pages, your own
server).

## Editing

| File | What it is |
|---|---|
| `page.html` | The page, in English: **edit this one** |
| `it.json` | The Italian text, by the `data-t` keys in `page.html` |
| `site.json` | The site's address, and the title and description for search engines |
| `style.css` | The look |
| `logo.svg`, `img/` | Logo, icon, screenshots, and `og.png` (the preview image for links shared in chats and social media) |
| `build.js` | Makes the pages and the browser app: `node build.js` |
| `app/` | The browser app: `index.html`, `setup.html`, `web-native.js`, `web.css` (edit these); `lib/` and `providers.js` are written by `build.js` |
| `_headers` | Security headers for the browser app, on hosts that read this file |

After a change, run `node build.js`. It writes `index.html`, `it/index.html`,
`robots.txt`, (with an address) `sitemap.xml`, and the browser app's `app/lib/`
(copied from `nextcloud/`, `android/` and `mac/`); don't edit those by hand.
Run it again after changing the apps' interface, so the browser app has it too.

## Search engines

Each page has its own language, title and description; links between the
English and Italian pages (`hreflang`), so Google shows the right one; a
preview image for links; and a description of the app for search results
(schema.org `SoftwareApplication`).

**Once you know the address**, put it in `site.json` (`"url":
"https://blockwise.example"`) and run `node build.js`. That adds the canonical
links, the full image addresses for link previews, and `sitemap.xml`. Then
submit the sitemap in Google Search Console and Bing Webmaster Tools.

## Downloads

The buttons link to the files that the GitHub workflows publish from `main`:

| App | Release | File |
|---|---|---|
| Mac | `mac-latest` | `Blockwise-mac.dmg` |
| Android | `latest` | `Blockwise.apk` |
| Nextcloud | `nextcloud-latest` | `blockwise-nextcloud.tar.gz` |

They work for visitors once the GitHub repository is public. The links use the
repository's current name (`amecs-gh/tracker-android`); GitHub keeps them
working after a rename, but you can search `page.html` for `github.com/amecs-gh`
to update them.

## The browser app (`/app/`)

Blockwise in a web page, with **no Blockwise server**: the page does what the
Android app's Java side does (`app/web-native.js`), so the rest is the same
code as the phone and Mac apps.

- **Your data stays in the browser**, in IndexedDB, encrypted with AES-GCM
  under a key the browser keeps non-extractable (scripts can use it, not read
  it out). Clearing the site's data in the browser deletes it: the Account tab
  has **Export my data (JSON)**.
- **One tab at a time** (a second tab says so instead of overwriting the first).
- **Sync through Dropbox**, end-to-end encrypted with a passphrase (or, if you
  choose, without encryption), together with the Mac and Android apps. The
  login uses OAuth with PKCE and a random state: no app secret, no token to
  paste; only the refresh token is kept, encrypted as above.
- **Not in the browser:** Nextcloud (a page can't reach your server; use
  Blockwise inside Nextcloud instead) and Google Drive (without a server it
  needs either an app secret in the page or a new login every hour).
- The pages allow requests only to Dropbox's API (Content-Security-Policy),
  send no referrer, and can't be framed (`_headers`). Search engines don't
  index them.

**To turn on Dropbox:** in the [Dropbox App Console](https://www.dropbox.com/developers/apps)
open the Blockwise app (the same one the Mac and Android apps use), add the
redirect URI `https://<your site>/app/setup.html` under OAuth 2 → Redirect URIs,
and allow PKCE ("Allow public clients"). Put the app key in `site.json`
(`"providers": { "dropboxAppKey": "…" }`; it is public, there is no secret) and
run `node build.js`. Without a key the browser app works in the browser only.

Test: `node build.js && node test/webapp.test.js` (Playwright from `../mac`;
a stand-in Dropbox).
