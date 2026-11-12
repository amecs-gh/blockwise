// What Astro doesn't make on its own:
// - the browser app (website/app/) copied into the output as it is, and served
//   by the dev server too;
// - _headers (Netlify, Cloudflare Pages): security headers for every file, a
//   strict Content-Security-Policy for each site page, and the app's own;
// - robots.txt, and sitemap.xml (with links between the languages) once
//   site.json has the site's address.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = path.join(ROOT, 'app')

/** The site pages: only the site's own script (js/site.js), nothing from other sites, can't be framed */
export const SITE_CSP = "default-src 'none'; script-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.json': 'application/json' }

/** Every .html file in the output (not the browser app), as the paths visitors use */
function sitePages(dist) {
	const out = []
	const walk = (d, rel) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const r = rel + e.name
			if (e.isDirectory()) { if (r !== 'app' && r !== '_astro') walk(path.join(d, e.name), r + '/') }
			else if (e.name.endsWith('.html')) out.push('/' + (e.name === 'index.html' ? rel : r))
		}
	}
	walk(dist, '')
	return out.sort()
}

function headers(pages) {
	const rule = (p, lines) => [p, ...lines.map((l) => '  ' + l)].join('\n')
	const page = [`Content-Security-Policy: ${SITE_CSP}`]
	return [
		'# Written by integrations/blockwise.mjs at build time: edit it there.',
		'# Every file: no framing, no referrer, no sniffing, no powerful features.',
		rule('/*', [
			'X-Frame-Options: DENY',
			'Referrer-Policy: no-referrer',
			'X-Content-Type-Options: nosniff',
			'Permissions-Policy: accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()',
			'Cross-Origin-Opener-Policy: same-origin',
			'Cross-Origin-Resource-Policy: same-origin',
			'Strict-Transport-Security: max-age=31536000',
		]),
		'',
		'# The browser app: its pages set their own policy (they reach Dropbox); this adds no framing.',
		rule('/app/*', ["Content-Security-Policy: frame-ancestors 'none'"]),
		'',
		'# The site pages, one by one (a pattern like /* would also cover /app/).',
		...pages.flatMap((p) => {
			const out = [rule(p, page)]
			// The same page asked for without its final slash, before the host redirects
			if (p.length > 1 && p.endsWith('/')) out.push(rule(p.slice(0, -1), page))
			return out
		}),
		'',
		'# Built files have their content hash in the name',
		rule('/_astro/*', ['Cache-Control: public, max-age=31536000, immutable']),
		'',
	].join('\n')
}

export default function blockwise({ url, locales }) {
	return {
		name: 'blockwise',
		hooks: {
			// npm run dev: /app/ from website/app, as the build serves it
			'astro:server:setup': ({ server }) => {
				// First in line, once Astro has added its own (its trailing-slash check would turn /app/setup away)
				const app = (req, res, next) => {
					const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
					if (!p.startsWith('/app/')) return next()
					let f = path.join(APP, p.slice('/app/'.length), p.endsWith('/') ? 'index.html' : '')
					// /app/setup as well as /app/setup.html, as Cloudflare Pages and Netlify serve it
					if (!path.extname(f) && fs.existsSync(f + '.html')) f += '.html'
					if (!f.startsWith(APP + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return next()
					res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream')
					fs.createReadStream(f).pipe(res)
				}
				server.httpServer?.once('listening', () => server.middlewares.stack.unshift({ route: '', handle: app }))
			},
			'astro:build:done': ({ dir, logger }) => {
				const dist = fileURLToPath(dir)
				if (!fs.existsSync(path.join(APP, 'lib', 'tracker.js'))) throw new Error('app/lib is missing: run node build.js first (npm run build does)')
				fs.cpSync(APP, path.join(dist, 'app'), { recursive: true })
				const pages = sitePages(dist)
				fs.writeFileSync(path.join(dist, '_headers'), headers(pages))
				fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n${url ? `\nSitemap: ${url}/sitemap.xml\n` : ''}`)
				if (url) {
					// Each page with its versions in every language
					const indexed = pages.filter((p) => p.endsWith('/'))
					const other = (p, l) => (l === 'en' ? p.replace(/^\/it\//, '/') : p.startsWith('/it/') ? p : '/it' + p)
					const entries = indexed.map((p) => {
						const alts = locales.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${url}${other(p, l)}"/>`).join('')
						return `<url><loc>${url}${p}</loc>${alts}</url>`
					})
					fs.writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`)
				}
				logger.info(`app/ copied; _headers for ${pages.length} pages${url ? '; sitemap.xml' : ' (no url in site.json: no sitemap)'}`)
			},
		},
	}
}
