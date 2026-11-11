// Builds the website from page.html (English, with data-t markers) and it.json:
// index.html (English) and it/index.html (Italian), each with its search and
// social tags, plus sitemap.xml and robots.txt. Set "url" in site.json to the
// site's address (e.g. "https://blockwise.example") for the absolute links
// search engines and social previews want. node build.js
const fs = require('node:fs')
const path = require('node:path')
const dir = __dirname
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')
const site = JSON.parse(read('site.json'))
const IT = JSON.parse(read('it.json'))
const page = read('page.html')
const base = site.url.replace(/\/+$/, '')
const abs = (p) => (base ? `${base}/${p}` : p) // without a url: relative
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const PAGES = { en: '', it: 'it/' }

function build(lang) {
	const it = lang === 'it'
	const up = it ? '../' : ''
	let html = page
	// Text in the language: every element marked data-t, and image descriptions
	if (it) {
		html = html.replace(/(<(\w+)\b[^>]*\bdata-t="([^"]+)"[^>]*>)([\s\S]*?)(<\/\2>)/g, (m, open, tag, key, text, close) => {
			if (!(key in IT)) throw new Error('No Italian for ' + key)
			return open + esc(IT[key]) + close
		})
		html = html.replace(/alt="[^"]*"( data-t-alt="([^"]+)")/g, (m, attr, key) => `alt="${esc(IT[key])}"${attr}`)
		html = html.replace('<html lang="en">', '<html lang="it">')
		// Files are one folder up
		html = html.replace(/\b(src|href|srcset)="(?!https?:|#|\/|\.\.\/)([^"]+)"/g, `$1="${up}$2"`)
	}
	const url = (l) => abs(PAGES[l])
	// A page's address: absolute with a url, else relative to this page
	const href = (l) => (base ? url(l) : l === lang ? './' : it ? '../' : PAGES[l])
	const title = site.title[lang]
	const description = site.description[lang]
	const ld = {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'Blockwise',
		applicationCategory: 'ProductivityApplication',
		operatingSystem: 'macOS 13+, Android 8+, Nextcloud 32-35',
		description,
		inLanguage: lang,
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
		license: 'https://www.gnu.org/licenses/agpl-3.0.html',
		image: abs('img/og.png'),
		...(base ? { url: url(lang) } : {}),
	}
	const seo = [
		`<title>${esc(title)}</title>`,
		`<meta name="description" content="${esc(description)}">`,
		'<meta name="robots" content="index, follow">',
		'<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">',
		'<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">',
		base ? `<link rel="canonical" href="${url(lang)}">` : null,
		...Object.keys(PAGES).map((l) => `<link rel="alternate" hreflang="${l}" href="${href(l)}">`),
		`<link rel="alternate" hreflang="x-default" href="${href('en')}">`,
		'<meta property="og:type" content="website">',
		'<meta property="og:site_name" content="Blockwise">',
		`<meta property="og:title" content="${esc(title)}">`,
		`<meta property="og:description" content="${esc(description)}">`,
		`<meta property="og:locale" content="${it ? 'it_IT' : 'en_US'}">`,
		`<meta property="og:locale:alternate" content="${it ? 'en_US' : 'it_IT'}">`,
		base ? `<meta property="og:url" content="${url(lang)}">` : null,
		`<meta property="og:image" content="${base ? abs('img/og.png') : up + 'img/og.png'}">`,
		'<meta property="og:image:width" content="1200">',
		'<meta property="og:image:height" content="630">',
		`<meta property="og:image:alt" content="${esc(title)}">`,
		'<meta name="twitter:card" content="summary_large_image">',
		`<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
	].filter(Boolean).join('\n\t')
	html = html.replace('<!--seo-->', seo)
	// The other language: a plain link (search engines follow it; no redirects)
	html = html.replace('<!--lang-->', it
		? '<a class="lang" href="../" hreflang="en" lang="en" title="English">EN</a>'
		: '<a class="lang" href="it/" hreflang="it" lang="it" title="Italiano">IT</a>')
	if (/data-t(-alt)?="[^"]*"/.test(html)) html = html.replace(/ data-t(-alt)?="[^"]*"/g, '')
	const out = path.join(dir, PAGES[lang], 'index.html')
	fs.mkdirSync(path.dirname(out), { recursive: true })
	fs.writeFileSync(out, html)
}

build('en')
build('it')
fs.writeFileSync(path.join(dir, 'robots.txt'), `User-agent: *\nAllow: /\n${base ? `\nSitemap: ${abs('sitemap.xml')}\n` : ''}`)
if (base) {
	const links = Object.keys(PAGES).map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${abs(PAGES[l])}"/>`).join('')
	fs.writeFileSync(path.join(dir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${Object.keys(PAGES).map((l) => `<url><loc>${abs(PAGES[l])}</loc>${links}</url>`).join('\n')}\n</urlset>\n`)
} else fs.rmSync(path.join(dir, 'sitemap.xml'), { force: true })
console.log(base ? `built for ${base}` : 'built (no url in site.json: relative links, no sitemap)')
