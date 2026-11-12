// The Blockwise website: static pages only (no server, no client scripts),
// in English (/) and Italian (/it/). See README.md.
import fs from 'node:fs'
import { defineConfig } from 'astro/config'
import blockwise from './integrations/blockwise.mjs'

const site = JSON.parse(fs.readFileSync(new URL('./site.json', import.meta.url), 'utf8'))
const url = String(site.url || '').replace(/\/+$/, '')
const locales = ['en', 'it']

export default defineConfig({
	...(url ? { site: url } : {}),
	output: 'static',
	trailingSlash: 'always',
	build: {
		format: 'directory',
		// Stylesheets as files: the pages' Content-Security-Policy allows no inline styles
		inlineStylesheets: 'never',
	},
	compressHTML: true,
	devToolbar: { enabled: false },
	i18n: {
		defaultLocale: 'en',
		locales,
		routing: { prefixDefaultLocale: false },
	},
	integrations: [blockwise({ url, locales })],
	vite: {
		// Never data: URIs (the policy allows images and fonts from this site only)
		build: { assetsInlineLimit: 0 },
	},
})
