# Blockwise website

A static site in English and Italian (the IT/EN button, or `?lang=it`), in the
apps' look, light and dark. No build step, no cookies, no outside resources:
upload this folder as it is to any static host (Netlify, Cloudflare Pages,
GitHub Pages, your own server).

| File | What it is |
|---|---|
| `index.html` | The page, in English |
| `site.js` | The Italian text and the language switch |
| `style.css` | The look |
| `logo.svg`, `img/` | Logo, icon and screenshots |

## Downloads

The buttons link to the files that the GitHub workflows publish from `main`:

| App | Release | File |
|---|---|---|
| Mac | `mac-latest` | `Blockwise-mac.dmg` |
| Android | `latest` | `Blockwise.apk` |
| Nextcloud | `nextcloud-latest` | `blockwise-nextcloud.tar.gz` |

They work for visitors once the GitHub repository is public. The links use the
repository's current name (`amecs-gh/tracker-android`); GitHub keeps them
working after a rename, but you can search `index.html` for
`github.com/amecs-gh` to update them.

## Screenshots

`img/` holds the screenshots as WebP, from the apps' test harness with demo data.
