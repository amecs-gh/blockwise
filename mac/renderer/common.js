/* Helpers shared by the app's windows. */
;(function () {
	'use strict'
	function h(tag, attrs, ...children) {
		const el = document.createElement(tag)
		for (const [k, v] of Object.entries(attrs || {})) {
			if (v === null || v === undefined || v === false) continue
			if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
			else if (k === 'class') el.className = v
			else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p.startsWith('--') ? p : p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), val)
			else if (k in el && typeof v !== 'string') el[k] = v
			else el.setAttribute(k, v === true ? '' : v)
		}
		for (const c of children.flat(Infinity)) {
			if (c === null || c === undefined || c === false) continue
			el.append(c instanceof Node ? c : document.createTextNode(String(c)))
		}
		return el
	}
	const svgNS = 'http://www.w3.org/2000/svg'
	function icon(d, size = 16, filled = false) {
		const s = document.createElementNS(svgNS, 'svg')
		s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size)
		s.setAttribute('fill', filled ? 'currentColor' : 'none'); s.setAttribute('stroke', 'currentColor')
		s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round')
		s.setAttribute('aria-hidden', 'true')
		const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); s.append(p)
		return s
	}
	const ICONS = {
		play: 'M8 5.5v13l11-6.5z',
		stop: 'M7 7h10v10H7z',
		back: 'M15 18l-6-6 6-6',
		reload: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
		external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
		more: 'M5 12h.01M12 12h.01M19 12h.01',
		tracker: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
		calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
	}

	function duration(sec) {
		sec = Math.max(0, Math.round(sec))
		const hh = Math.floor(sec / 3600)
		const mm = Math.floor((sec % 3600) / 60)
		if (!hh && !mm) return '< 1m'
		return hh ? (mm ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${hh}h`) : `${mm}m`
	}
	function clock(sec) {
		sec = Math.max(0, Math.round(sec))
		const hh = Math.floor(sec / 3600)
		const p = (x) => String(x).padStart(2, '0')
		return hh ? `${hh}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}` : `${p(Math.floor(sec / 60))}:${p(sec % 60)}`
	}
	/** Text color that reads on a background color. */
	function onColor(hex) {
		const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '')
		if (!m) return '#fff'
		const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
		return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1a1a1a' : '#ffffff'
	}
	/** Same syntax as the web app: "Draft 45m", "Draft 1h30". */
	function parseEstimate(line) {
		const m = /^(.*\S)\s+(?:(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*(?:m|min)?)?|(\d+)\s*(?:m|min))$/i.exec(line.trim())
		if (!m) return { title: line.trim(), estimate: null }
		const minutes = m[4] ? Number(m[4]) : Math.round(Number(m[2].replace(',', '.')) * 60) + (m[3] ? Number(m[3]) : 0)
		return { title: m[1], estimate: minutes > 0 ? minutes : null }
	}
	window.ui = { h, icon, ICONS, duration, clock, onColor, parseEstimate }
})()
