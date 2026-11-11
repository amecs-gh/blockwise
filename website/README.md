# Blockwise website

A static site in English (`/`) and Italian (`/it/`), in a calm Apple-like look,
light and dark. No cookies, no scripts, nothing loaded from other sites: upload
this folder as it is to any static host (Netlify, Cloudflare Pages, GitHub
Pages, your own server).

## Editing

| File | What it is |
|---|---|
| `page.html` | The page, in English: **edit this one** |
| `it.json` | The Italian text, by the `data-t` keys in `page.html` |
| `site.json` | The site's address, and the title and description for search engines |
| `style.css` | The look |
| `logo.svg`, `img/` | Logo, icon, screenshots, and `og.png` (the preview image for links shared in chats and social media) |
| `build.js` | Makes the pages: `node build.js` |

After a change, run `node build.js`. It writes `index.html`, `it/index.html`,
`robots.txt` and (with an address) `sitemap.xml`; don't edit those by hand.

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
