// The site's two languages. Every page exists in both, at the same path:
// /features/ and /it/features/. Text sits next to its translation in the
// views, as t({ en: '…', it: '…' }).
import siteJson from '../site.json'

export type Lang = 'en' | 'it'
export const LANGS: Lang[] = ['en', 'it']
export type Text = { en: string; it: string }

export const site = siteJson as {
	url: string
	title: Text
	description: Text
}

/** A translator for one language */
export const tr = (lang: Lang) => (o: Text) => o[lang]

/** The pages, in the order of the menu (home first). `key` is the path without the language. */
export const PAGES = [
	{ key: '', label: { en: 'Home', it: 'Home' } },
	{ key: 'features/', label: { en: 'Features', it: 'Funzioni' } },
	{ key: 'guide/', label: { en: 'Guide', it: 'Guida' } },
	{ key: 'privacy/', label: { en: 'Privacy & security', it: 'Privacy e sicurezza' } },
	{ key: 'download/', label: { en: 'Download', it: 'Scarica' } },
] as const
export type PageKey = (typeof PAGES)[number]['key']

/** A page's address in a language, from the site's root */
export const href = (lang: Lang, key: string) => (lang === 'en' ? '/' : '/it/') + key

/** The release files the GitHub workflows publish from main */
export const REPO = 'https://github.com/amecs-gh/blockwise'
export const DOWNLOADS = {
	mac: `${REPO}/releases/download/mac-latest/Blockwise-mac.dmg`,
	android: `${REPO}/releases/download/latest/Blockwise.apk`,
	nextcloud: `${REPO}/releases/download/nextcloud-latest/blockwise-nextcloud.tar.gz`,
	releases: `${REPO}/releases`,
	security: `${REPO}/security/advisories/new`,
	license: `${REPO}/blob/main/LICENSE`,
}
