# Website: move to a multipage Astro site

**Status: done (2026-11-12).** The site is built with Astro; see `README.md`.
Left for the owner: put the site's address in `site.json` once known, set up
Netlify or Cloudflare Pages (base directory `website`), and add the redirect
URI and app key for Dropbox in the browser app.

Handoff for the next session. Read this first, then `website/README.md`, the
root `README.md` and the app's interface (`nextcloud/js/tracker.js`,
`nextcloud/css/tracker.css`).

## The task

Turn `website/` (today one page in English and Italian, built by `build.js`)
into a **multipage website built with Astro**, in **the app's own look**.
Ask the owner about anything unclear.

### Decisions already made

- **Generator:** Astro, static output only (no server, no SSR adapter).
- **Pages besides the home page:**
  - **Features**: one section or page per area: commitments and blocks, tasks
    (queue, subtasks, estimates), tracking (timer, Pomodoro), Done and Time
    (weekly goals, CSV export), notes (Markdown, checklists).
  - **Guide / how-to**: getting started, planning a week in blocks, syncing
    devices (Dropbox, Google Drive, Nextcloud; end-to-end encryption and the
    passphrase).
  - **Privacy & security**: where data lives on each platform, the
    encryption, no Blockwise server, open source (AGPL-3.0).
  - **Download + FAQ**: browser, Mac, Android, Nextcloud with install steps
    (from today's `page.html`), common questions, a changelog of releases.
- **Look: the app's**: Poppins (the fonts are in `nextcloud/css/fonts`),
  the app's colors and tokens (`--tl-*`, accent #6c5ce7), soft rounded cards,
  the colored timer card, goal rings (`goalRings` in tracker.js, `.imp-ring*`
  in tracker.css), task columns. Use real interface pieces as illustrations,
  in light and dark.
- **Hosting:** Netlify or Cloudflare Pages: real security headers via
  `_headers` (keep the current ones for `/app/*`; add a strict policy for
  the site pages).
- **Languages:** English and Italian, as today (Astro i18n routing, `/` and
  `/it/`); every page in both.

### What must keep working

- The browser app at `/app/` (`website/app/`): copy it to the output as it
  is (Astro `public/`, or a build step that runs today's `buildApp()` from
  `build.js`). Its test: `node test/webapp.test.js`.
- The links to the GitHub release downloads (see `page.html`).
- Static pages with no tracking, no cookies, nothing loaded from other sites
  (fonts self-hosted), and no client JavaScript unless something truly needs
  it.

## Standing instructions from the owner

- **Be strict about security**: "Be particularly picky when it comes to
  security, since I don't want my data to be vulnerable to attacks."
- The signing key never goes into the repository (GitHub secrets only).
- Don't create accounts for the owner. No root privileges.
- `.github/workflows/*` can't be written from the session.
- Commits: `git -c user.name=amecs-gh -c user.email=353991799+amecs-gh@users.noreply.github.com commit`,
  push to `main`, then check the workflows with `gh run list` (Mac, Android,
  Nextcloud app, Checks).
- **Always copy changed files back to the owner's Mac** at
  `/Users/manuel/Projects/blockwise/` when the session is linked to it, and
  verify them with md5 (the owner isn't logged in to git there, so pulling
  isn't an option). Binary files (PNG) can be changed on the way: copy them on
  the Mac from an identical source or check them separately.
- Run the existing test suites before committing (`mac/test/*.test.js`,
  `nextcloud/tests/*.test.js`, `android/test/ui.test.js`,
  `website/test/webapp.test.js`).
