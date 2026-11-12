# Blockwise website

A static website built with [Astro](https://astro.build), in English (`/`) and
Italian (`/it/`), in the app's own look (Poppins, the `--tl-*` colors, rounded
cards, light and dark), plus Blockwise itself in the browser at `/app/`.

No cookies, no tracking, no client scripts, nothing loaded from other sites
(the fonts are the app's own Poppins files, served from the site).

## Pages

Every page exists in both languages, at the same path (`/guide/`, `/it/guide/`).

| Page | Source |
|---|---|
| Home | `src/views/Home.astro` |
| Features (blocks, tasks, tracking, Done and Time, notes) | `src/views/Features.astro` |
| Guide (getting started, planning a week, syncing) | `src/views/Guide.astro` |
| Privacy & security | `src/views/Privacy.astro` |
| Download, FAQ and what's new | `src/views/Download.astro`, `src/data/changelog.ts` |
| Not found | `src/pages/404.astro` |

`src/pages/*.astro` and `src/pages/it/*.astro` only pick the language. The text
sits next to its translation in the views: `t({ en: '…', it: '…' })`.

| Other files | What they are |
|---|---|
| `src/layouts/Layout.astro` | The head (search and link-preview tags, links between the languages), menu bar, footer |
| `src/i18n.ts` | The languages, the menu, the download links |
| `src/components/` | The illustrations: pieces of the interface (timer card, goal rings, task columns, calendar week, note, Done, Time, sync), drawn with the app's styles |
| `src/styles/site.css`, `ui.css` | The look, and the interface pieces |
| `public/` | Logo, icon, screenshots, `og.png` (the link preview image) |
| `site.json` | The site's address, the title and description for search engines, the Dropbox app key |
| `build.js` | Prepares the browser app (`app/lib/`, `app/providers.js`) and the fonts (`public/fonts/`) |
| `integrations/blockwise.mjs` | Copies `app/` into the output; writes `_headers`, `robots.txt` and (with an address) `sitemap.xml` |
| `app/` | The browser app (see below) |

## Building

Node 22.23.4 or later.

```sh
npm ci
npm run dev      # http://localhost:4321, the browser app at /app/ too
npm run build    # the site in dist/
```

`npm run build` runs `node build.js` and then Astro. Upload `dist/` to the host.
Don't edit `app/lib/`, `app/providers.js` or `public/fonts/` by hand: they are
copied from `nextcloud/`, `android/` and `mac/`. Build again after changing the
apps' interface, so the browser app has it too.

## Hosting

**Netlify** or **Cloudflare Pages**: base (root) directory `website`, build
command `npm ci && npm run build`, output directory `dist`, Node 22.23.4 or
later (`netlify.toml` sets this for Netlify; on Cloudflare Pages set
`NODE_VERSION`).

Both read `dist/_headers`, written at build time:

- **Every file:** no framing, no referrer, `nosniff`, no powerful features
  (camera, microphone, location, payment, USB, …), cross-origin isolation of
  windows and resources, HSTS.
- **Every site page**, listed one by one: a strict Content-Security-Policy —
  `default-src 'none'`, styles, images and fonts from the site only, no
  scripts, no forms, can't be framed. (A pattern like `/*` would also cover
  `/app/`, whose pages need to reach Dropbox.) The pages repeat the policy in a
  `<meta>` tag, for hosts that ignore `_headers`.
- **`/app/*`:** `frame-ancestors 'none'`; the app's pages set their own policy
  (only Dropbox's API).
- **`/_astro/*`:** cached for a year (the names have content hashes).

The site expects to be served from the root of its address.

## Search engines

Each page has its own language, title and description, `hreflang` links to
the other language, a link preview image and (home page) a schema.org
`SoftwareApplication`.

**Once you know the address**, put it in `site.json` (`"url":
"https://blockwise.example"`) and build again. That adds canonical links, full
image addresses for link previews, and `sitemap.xml`. Then submit the sitemap
in Google Search Console and Bing Webmaster Tools.

## Downloads

The buttons link to the files that the GitHub workflows publish from `main`
(see `DOWNLOADS` in `src/i18n.ts`):

| App | Release | File |
|---|---|---|
| Mac | `mac-latest` | `Blockwise-mac.dmg` |
| Android | `latest` | `Blockwise.apk` |
| Nextcloud | `nextcloud-latest` | `blockwise-nextcloud.tar.gz` |

They work for visitors once the GitHub repository is public. Add an entry to
`src/data/changelog.ts` when something visible changes.

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
build again. Without a key the browser app works in the browser only.

Test: `node build.js && node test/webapp.test.js` (Playwright from `../mac`;
a stand-in Dropbox).
