/*
 * Markdown for notes: text -> a small tree, never HTML. The interface builds
 * elements from the tree (text nodes and a fixed set of tags), so a note can't
 * inject markup or scripts whatever it contains.
 *
 * Supported: # headings, paragraphs (a line break is a line break),
 * **bold** __bold__, *italic* _italic_, ~~strikethrough~~, `code`,
 * ``` code blocks ```, > quotes, - * + bullet lists, 1. numbered lists,
 * - [ ] / - [x] checklists (nested by indenting), --- separators,
 * [links](https://…) and bare https:// addresses (http and https only).
 *
 * Usable in browsers (window.TrackerMarkdown) and Node (require).
 */
;(function (root) {
	'use strict'

	const MAX_DEPTH = 8
	const MAX_LEN = 20000

	/** Only web addresses become links (no javascript:, data:, file: …) */
	function safeUrl(url) {
		const u = String(url || '').trim()
		if (!/^https?:\/\/[^\s<>"'`]+$/i.test(u)) return null
		try {
			const parsed = new URL(u)
			return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
		} catch (e) {
			return null
		}
	}

	// --- inline ---------------------------------------------------------------------------

	/**
	 * @return {Array} nodes: {t:'text', v} {t:'strong'|'em'|'del', c:[…]} {t:'code', v}
	 *   {t:'link', href, c:[…]} {t:'br'}
	 */
	function inline(src, depth = 0) {
		const out = []
		let text = ''
		const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = '' } }
		let i = 0
		while (i < src.length) {
			const ch = src[i]
			const rest = src.slice(i)
			let m
			if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#>+\-.!|]/.test(src[i + 1])) {
				text += src[i + 1]
				i += 2
				continue
			}
			if (ch === '\n') {
				flush()
				out.push({ t: 'br' })
				i++
				continue
			}
			if (ch === '`' && (m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) {
				flush()
				out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') })
				i += m[0].length
				continue
			}
			if (depth < MAX_DEPTH) {
				if (ch === '[' && (m = /^\[([^\]\n]{1,500})\]\(\s*([^()\s]{1,2000})\s*\)/.exec(rest))) {
					const href = safeUrl(m[2])
					flush()
					if (href) out.push({ t: 'link', href, c: inline(m[1], depth + 1) })
					else out.push(...inline(m[1], depth + 1)) // not a web address: just the text
					i += m[0].length
					continue
				}
				if ((ch === '*' || ch === '_') && (m = (ch === '*' ? /^\*\*(?=\S)([\s\S]*?\S)\*\*/ : /^__(?=\S)([\s\S]*?\S)__(?!\w)/).exec(rest))) {
					flush()
					out.push({ t: 'strong', c: inline(m[1], depth + 1) })
					i += m[0].length
					continue
				}
				if (ch === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
					flush()
					out.push({ t: 'del', c: inline(m[1], depth + 1) })
					i += m[0].length
					continue
				}
				// *italic* and _italic_ only at word edges (snake_case and 2*3*4 stay as they are)
				const before = i === 0 ? ' ' : src[i - 1]
				if ((ch === '*' || ch === '_') && !/[\p{L}\p{N}]/u.test(before) && (m = (ch === '*' ? /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![*\p{L}\p{N}])/u : /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u).exec(rest))) {
					flush()
					out.push({ t: 'em', c: inline(m[1], depth + 1) })
					i += m[0].length
					continue
				}
			}
			if ((ch === 'h' || ch === 'H') && /\W|^$/.test(i === 0 ? '' : src[i - 1]) && (m = /^https?:\/\/[^\s<>"'`]+/i.exec(rest))) {
				// a bare address; trailing punctuation stays text
				let url = m[0].replace(/[.,;:!?)\]]+$/, '')
				const href = safeUrl(url)
				if (href) {
					flush()
					out.push({ t: 'link', href, c: [{ t: 'text', v: url }] })
					i += url.length
					continue
				}
			}
			text += ch
			i++
		}
		flush()
		return out
	}

	// --- blocks ---------------------------------------------------------------------------

	const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/
	const indentOf = (line) => /^ */.exec(line)[0].length

	/**
	 * @param {string[]} lines
	 * @param {number} base line number of lines[0] in the note (for checklist ticks)
	 * @return {Array} blocks: {t:'h', level, c} {t:'p', c} {t:'code', v} {t:'quote', b:[…]} {t:'hr'}
	 *   {t:'ul'|'ol', start, items:[{task: null|false|true, line, c:[…inline], b:[…nested blocks]}]}
	 */
	function blocks(lines, base, depth) {
		const out = []
		let i = 0
		while (i < lines.length) {
			const line = lines[i]
			let m
			if (!line.trim()) { i++; continue }
			if ((m = /^ {0,3}(```|~~~)\s*([\w+-]*)\s*$/.exec(line))) {
				const fence = m[1]
				const body = []
				i++
				while (i < lines.length && !new RegExp('^ {0,3}' + fence + '\\s*$').test(lines[i])) body.push(lines[i++])
				i++ // closing fence (or the end)
				out.push({ t: 'code', lang: m[2] || null, v: body.join('\n') })
				continue
			}
			if ((m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
				out.push({ t: 'h', level: m[1].length, c: inline(m[2]) })
				i++
				continue
			}
			if (/^ {0,3}([-*_])( *\1){2,}\s*$/.test(line)) {
				out.push({ t: 'hr' })
				i++
				continue
			}
			if (/^ {0,3}>/.test(line)) {
				const start = i
				const body = []
				while (i < lines.length && /^ {0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''))
				out.push(depth < MAX_DEPTH ? { t: 'quote', b: blocks(body, base + start, depth + 1) } : { t: 'p', c: inline(body.join('\n')) })
				continue
			}
			if ((m = LIST_RE.exec(line)) && depth < MAX_DEPTH) {
				const ordered = /\d/.test(m[2])
				const indent = m[1].length
				const list = { t: ordered ? 'ol' : 'ul', start: ordered ? parseInt(m[2], 10) : 1, items: [] }
				while (i < lines.length) {
					const lm = LIST_RE.exec(lines[i])
					if (!lm || lm[1].length !== indent || /\d/.test(lm[2]) !== ordered) break
					const item = { task: null, line: base + i, c: [], b: [] }
					let content = lm[3]
					const tm = /^\[([ xX])\]\s+(.*)$/.exec(content) || /^\[([ xX])\]$/.exec(content)
					if (tm) {
						item.task = tm[1] !== ' '
						content = tm[2] || ''
					}
					const textLines = [content]
					const childLines = []
					const childStart = i + 1
					i++
					// continuation lines and nested lists: indented more than the marker
					while (i < lines.length && lines[i].trim() && (indentOf(lines[i]) > indent) ) {
						if (LIST_RE.test(lines[i]) || childLines.length) childLines.push(lines[i].slice(Math.min(indentOf(lines[i]), indent + 2)))
						else textLines.push(lines[i].trim())
						i++
					}
					item.c = inline(textLines.join('\n'))
					if (childLines.length) item.b = blocks(childLines, base + childStart + (textLines.length - 1), depth + 1)
					list.items.push(item)
					// a blank line between items of the same list is fine
					if (i < lines.length && !lines[i].trim() && i + 1 < lines.length) {
						const next = LIST_RE.exec(lines[i + 1])
						if (next && next[1].length === indent && /\d/.test(next[2]) === ordered) i++
					}
				}
				out.push(list)
				continue
			}
			// paragraph: until a blank line or another block starts
			const body = []
			while (i < lines.length && lines[i].trim() && !/^ {0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !/^ {0,3}([-*_])( *\1){2,}\s*$/.test(lines[i])) {
				body.push(lines[i].trim())
				i++
			}
			if (!body.length) { body.push(lines[i].trim()); i++ }
			out.push({ t: 'p', c: inline(body.join('\n')) })
		}
		return out
	}

	function parse(text) {
		const src = String(text || '').replace(/\r\n?/g, '\n').slice(0, MAX_LEN)
		return blocks(src.split('\n'), 0, 0)
	}

	/** Ticks or unticks the checklist item on line `line` of the note. */
	function toggleTask(text, line, done) {
		const lines = String(text).split('\n')
		if (line < 0 || line >= lines.length) return text
		lines[line] = lines[line].replace(/^( *(?:[-*+]|\d{1,9}[.)])\s+)\[[ xX]\]/, `$1[${done ? 'x' : ' '}]`)
		return lines.join('\n')
	}

	/** Checklist items of a note: [done, total] */
	function taskCount(text) {
		let done = 0
		let total = 0
		for (const line of String(text || '').split('\n')) {
			const m = /^ *(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]/.exec(line)
			if (m) { total++; if (m[1] !== ' ') done++ }
		}
		return [done, total]
	}

	/**
	 * A note's first line as plain text (lists, Done): markdown removed,
	 * at most 120 characters. Same rules as the server (NoteService::title).
	 */
	function plainTitle(text) {
		let line = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n')[0].trim()
		line = line.replace(/^(#{1,6}\s+|>\s*|```\S*|~~~\S*)/, '').replace(/^([-*+]|\d{1,9}[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '')
		line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)/g, '').replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2').trim()
		const chars = [...line]
		return chars.length > 120 ? chars.slice(0, 119).join('').trimEnd() + '…' : line
	}

	const api = { parse, inline, toggleTask, taskCount, plainTitle, safeUrl }
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	else root.TrackerMarkdown = api
})(typeof window !== 'undefined' ? window : globalThis)
