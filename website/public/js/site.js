// The website's only script: the theme you pick (automatic, light or dark),
// kept in this browser and never sent anywhere, and the menu on small screens.
// It runs in <head> so a chosen theme applies before the page is drawn.
// Without it the pages still work: the system's theme, and the menu always open.
;(function () {
	'use strict'
	var KEY = 'blockwise.theme'
	var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
	// Each click changes what you see: from automatic to the other theme, then the system's, then automatic
	function next(c) {
		var sys = dark && dark.matches ? 'dark' : 'light'
		var other = sys === 'dark' ? 'light' : 'dark'
		return c === 'auto' ? other : c === other ? sys : 'auto'
	}
	var PAGE = { light: '#f6f5fb', dark: '#14121d' }
	var root = document.documentElement
	var choice = 'auto'

	function stored() {
		try {
			var v = localStorage.getItem(KEY)
			return v === 'light' || v === 'dark' ? v : 'auto'
		} catch (e) {
			return choice
		}
	}
	function save(c) {
		try {
			if (c === 'auto') localStorage.removeItem(KEY)
			else localStorage.setItem(KEY, c)
		} catch (e) { /* private mode: for this page only */ }
	}
	function apply(c) {
		choice = c
		if (c === 'auto') root.removeAttribute('data-theme')
		else root.setAttribute('data-theme', c)
		root.setAttribute('data-theme-choice', c)
		// The browser's bar follows the page
		var metas = document.querySelectorAll('meta[name="theme-color"]')
		for (var i = 0; i < metas.length; i++) {
			var m = metas[i]
			if (!m.hasAttribute('data-media')) m.setAttribute('data-media', m.getAttribute('media') || '')
			if (c === 'auto') m.setAttribute('media', m.getAttribute('data-media'))
			else { m.removeAttribute('media'); m.setAttribute('content', PAGE[c]) }
		}
		if (c === 'auto') {
			for (var j = 0; j < metas.length; j++) metas[j].setAttribute('content', /dark/.test(metas[j].getAttribute('media')) ? PAGE.dark : PAGE.light)
		}
		label()
	}

	var themeBtn = null
	function label() {
		if (!themeBtn) return
		var text = themeBtn.getAttribute('data-to-' + next(choice))
		themeBtn.setAttribute('aria-label', text)
		themeBtn.title = text
	}

	root.classList.add('js')
	apply(stored())

	document.addEventListener('DOMContentLoaded', function () {
		apply(choice) // the theme-color tags are parsed by now
		themeBtn = document.getElementById('theme')
		if (themeBtn) {
			themeBtn.hidden = false
			label()
			themeBtn.addEventListener('click', function () {
				var c = next(choice)
				save(c)
				apply(c)
			})
		}

		var bar = document.querySelector('.bar')
		var menuBtn = document.getElementById('menu-button')
		if (!bar || !menuBtn) return
		menuBtn.hidden = false
		function setOpen(open) {
			bar.classList.toggle('is-open', open)
			menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
		}
		menuBtn.addEventListener('click', function () {
			setOpen(!bar.classList.contains('is-open'))
		})
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && bar.classList.contains('is-open')) {
				setOpen(false)
				menuBtn.focus()
			}
		})
		document.addEventListener('click', function (e) {
			if (bar.classList.contains('is-open') && !bar.contains(e.target)) setOpen(false)
		})
	})

	// The system's theme changed: the label of the next step changes with it
	if (dark && dark.addEventListener) dark.addEventListener('change', label)

	// Another tab changed the theme
	window.addEventListener('storage', function (e) {
		if (e.key === KEY) apply(stored())
	})
})()
