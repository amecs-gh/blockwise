// Blockwise website: English (in the page) or Italian. Picks the browser's
// language, or ?lang=it / ?lang=en; the IT/EN button switches and is remembered.
;(function () {
	const IT = {
		'nav.how': 'Come funziona',
		'nav.features': 'Funzioni',
		'nav.privacy': 'I tuoi dati',
		'nav.download': 'Scarica',
		'hero.eyebrow': 'Per Mac, Android e Nextcloud',
		'hero.title': 'Pianifica la settimana a blocchi.',
		'hero.sub': 'Affrontala un blocco alla volta.',
		'hero.lead': 'Dai a ogni impegno blocchi di tempo nel calendario. Blockwise riempie ogni blocco con i prossimi task, registra il tempo con un tocco e ti mostra dove è finita davvero la settimana.',
		'hero.cta': 'Scarica',
		'hero.more': 'Guarda come funziona',
		'hero.free': 'Gratis e open source (AGPL-3.0). In italiano e in inglese.',
		'shot.now': 'La pagina Adesso: i blocchi di oggi come una timeline, il timer in corso e i task di questo blocco',
		'shot.phone': 'Blockwise su un telefono Android',
		'shot.calendar': 'Il calendario: una settimana di blocchi nel colore di ogni impegno',
		'how.title': 'Come funziona',
		'how.1.t': 'Impegni',
		'how.1.p': 'Ciò a cui dai tempo: Tesi, Lavoro, Didattica. Ognuno ha il suo colore e il suo calendario.',
		'how.2.t': 'Blocchi',
		'how.2.p': 'Ogni evento nel calendario di un impegno è un blocco di tempo per lui. Trascina per pianificarli; ripetili ogni giorno feriale o ogni settimana.',
		'how.3.t': 'I task riempiono i blocchi',
		'how.3.p': 'I task fanno la fila per ogni impegno, con sotto-task e stime come "Bozza 45m". Ogni blocco prende i task dall\'alto finché è pieno; quello che non finisci passa al blocco successivo.',
		'how.4.t': 'Premi play',
		'how.4.p': 'Registra il tempo con un tocco, sul Mac anche dalla barra dei menu. Ti sei dimenticato di avviarlo? Sposta indietro l\'inizio. Fatto e Tempo mostrano la settimana com\'è andata davvero.',
		'shots.cal.t': 'Un calendario fatto per i blocchi',
		'shots.cal.p': 'Giorno, settimana e mese. Trascina per creare, spostare o allungare un blocco; cliccane uno per vedere i task che lo aspettano. Usa il calendario integrato, Calendario di Apple o i calendari di Nextcloud.',
		'feat.title': 'Tutto per settimane concentrate',
		'feat.1.t': 'Adesso',
		'feat.1.p': 'Oggi come una timeline, il timer in corso e solo i task di questo blocco.',
		'feat.2.t': 'Task e stime',
		'feat.2.p': 'Una coda ordinata per ogni impegno. Spunta i sotto-task in ordine; ti avvisa quando i task richiedono più tempo di quello nei blocchi.',
		'feat.3.t': 'Note',
		'feat.3.p': 'Note per ogni impegno in Markdown, con liste da spuntare.',
		'feat.4.t': 'Obiettivi settimanali',
		'feat.4.p': 'Ore a settimana per ogni impegno, con l\'avanzamento nella pagina Adesso.',
		'feat.5.t': 'Fatto e Tempo',
		'feat.5.p': 'La settimana su una timeline: blocchi pianificati, tempo registrato e ciò che hai spuntato. Ore per impegno, con esportazione CSV.',
		'feat.6.t': 'Pomodoro e promemoria',
		'feat.6.p': 'Cicli Pomodoro facoltativi e un promemoria prima della fine di un blocco.',
		'priv.title': 'I tuoi dati restano tuoi',
		'priv.lead': 'Nessun account da noi, nessun tracciamento, nessuna pubblicità. Blockwise funziona offline e sincronizza solo dove scegli tu.',
		'priv.nc': 'Sul tuo server. I blocchi sono eventi in Calendario di Nextcloud; Mac, telefono e web restano sincronizzati.',
		'priv.drive': 'Solo Mac. Sincronizzato tramite il tuo Dropbox o Google Drive, cifrato end-to-end con una passphrase che conosci solo tu.',
		'priv.local.t': 'Solo su questo Mac',
		'priv.local': 'Nessuna sincronizzazione. Puoi collegarne una in seguito e i tuoi dati vengono con te.',
		'dl.title': 'Scarica',
		'dl.mac.req': 'Mac con Apple silicon, macOS 13 o successivo',
		'dl.mac.btn': 'Scarica per Mac (.dmg)',
		'dl.mac.1': 'Apri il .dmg e trascina Blockwise su Applicazioni.',
		'dl.mac.2': 'L\'app non è ancora autenticata da Apple. La prima volta aprila, poi vai in Impostazioni di Sistema → Privacy e sicurezza e clicca Apri comunque.',
		'dl.and.req': 'Android 8 o successivo · serve un Nextcloud',
		'dl.and.btn': 'Scarica per Android (.apk)',
		'dl.and.1': 'Apri Blockwise.apk sul telefono; se richiesto, consenti al browser di installare app.',
		'dl.and.2': 'Accedi al tuo Nextcloud. I blocchi vengono dai calendari del telefono: sincronizza i calendari di Nextcloud con DAVx⁵.',
		'dl.nc.req': 'Nextcloud da 32 a 35, con l\'app Calendario',
		'dl.nc.btn': 'Scarica l\'app per Nextcloud',
		'dl.nc.1': 'Estraila nella cartella apps del server: crea una cartella chiamata tracker.',
		'dl.nc.2': 'Attiva Blockwise in App, oppure esegui: occ app:enable tracker',
		'dl.how': 'Come installarla',
		'dl.all': 'Tutte le versioni e il codice sorgente su GitHub',
		'foot': 'Open source con licenza AGPL-3.0. Nato da TimeManager di Thomas Ebert.',
	}
	const title = { en: document.title, it: 'Blockwise · pianifica la settimana a blocchi' }
	const els = [...document.querySelectorAll('[data-t]')]
	const alts = [...document.querySelectorAll('[data-t-alt]')]
	const EN = new Map(els.map((el) => [el, el.textContent]))
	const ENALT = new Map(alts.map((el) => [el, el.alt]))
	const btn = document.getElementById('lang')

	function apply(lang) {
		const it = lang === 'it'
		document.documentElement.lang = lang
		document.title = title[lang]
		for (const el of els) el.textContent = it ? IT[el.dataset.t] || EN.get(el) : EN.get(el)
		for (const el of alts) el.alt = it ? IT[el.dataset.tAlt] || ENALT.get(el) : ENALT.get(el)
		btn.textContent = it ? 'EN' : 'IT'
		btn.setAttribute('aria-label', it ? 'English' : 'Italiano')
	}

	let saved = null
	try { saved = localStorage.getItem('lang') } catch (e) { /* storage off: use the browser's language */ }
	const asked = new URLSearchParams(location.search).get('lang')
	let lang = asked === 'it' || asked === 'en' ? asked : saved === 'it' || saved === 'en' ? saved : (navigator.language || '').toLowerCase().startsWith('it') ? 'it' : 'en'
	apply(lang)
	btn.addEventListener('click', () => {
		lang = lang === 'it' ? 'en' : 'it'
		try { localStorage.setItem('lang', lang) } catch (e) { /* not remembered */ }
		apply(lang)
	})
})()
