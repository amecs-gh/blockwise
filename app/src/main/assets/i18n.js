/* Texts for the main process and the windows (English, Italian).
 * Loaded with require() in the main process and as a <script> in the windows. */
;(function (root) {
	'use strict'
	const it = {
		'Tracker': 'Tracker',
		'Calendar': 'Calendario',
		'Back': 'Indietro',
		'Reload': 'Ricarica',
		'Open in browser': 'Apri nel browser',
		'Connect to your Nextcloud': 'Collegati al tuo Nextcloud',
		'Tracker uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored in your Keychain.': 'Tracker usa i tuoi impegni, task e calendario di Nextcloud. Accedi una volta; l\'app riceve una propria password, salvata nel Portachiavi.',
		'Tracker uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.': 'Tracker usa i tuoi impegni, task e calendario di Nextcloud. Accedi una volta; l\'app riceve una propria password, salvata cifrata su questo telefono.',
		'Log in and tap "Grant access" on the Nextcloud page.': 'Accedi e tocca "Concedi accesso" nella pagina di Nextcloud.',
		'Nextcloud address': 'Indirizzo di Nextcloud',
		'e.g. cloud.example.com or your Tailscale name': 'es. cloud.example.com o il nome Tailscale',
		'Log in': 'Accedi',
		'Cancel': 'Annulla',
		'Log in and click "Grant access" in the window that opened.': 'Accedi e clicca "Concedi accesso" nella finestra che si è aperta.',
		'Not tracking': 'Nessuna registrazione',
		'Unplanned': 'Non pianificato',
		'Track unplanned time': 'Registra tempo non pianificato',
		'Stop': 'Ferma',
		'Start {name}': 'Avvia {name}',
		'Stop {name}': 'Ferma {name}',
		'{time} left in this block': '{time} rimanenti in questo blocco',
		'Focus': 'Concentrazione',
		'Short break': 'Pausa breve',
		'Long break': 'Pausa lunga',
		'Round {round} of {of}': 'Sessione {round} di {of}',
		'{time} until the short break': '{time} alla pausa breve',
		'{time} until the long break': '{time} alla pausa lunga',
		'{time} until focus': '{time} alla concentrazione',
		'Back to work in {time}': 'Si riprende tra {time}',
		'In this block': 'In questo blocco',
		'Next block': 'Prossimo blocco',
		'Up next': 'In arrivo',
		'No open tasks.': 'Nessun task aperto.',
		'Add a subtask, e.g. "Check figures 20m"': 'Aggiungi un sottotask, es. "Controlla figure 20m"',
		'Add to': 'Aggiungi a',
		'Commitments': 'Impegni',
		'No block planned': 'Nessun blocco pianificato',
		'{done} of {goal} this week': '{done} di {goal} questa settimana',
		'Today': 'Oggi',
		'Tomorrow': 'Domani',
		'{time} left': '{time} rimanenti',
		'Open Tracker': 'Apri Tracker',
		'{n} more in Tracker': 'altri {n} in Tracker',
		'Open Calendar': 'Apri Calendario',
		'Open at login': 'Apri all\'accesso',
		'Desktop notifications': 'Notifiche desktop',
		'Log out': 'Esci',
		'Quit Tracker': 'Esci da Tracker',
		'Logged in as {user} on {host}': 'Accesso come {user} su {host}',
		'Loading…': 'Caricamento…',
		'Retry': 'Riprova',
		'Done: {title}': 'Fatto: {title}',
		'Log out of {host}? The app password is removed from Nextcloud.': 'Uscire da {host}? La password dell\'app viene rimossa da Nextcloud.',
		'Log in again': 'Accedi di nuovo',
		'Nextcloud rejected the app password. Log in again.': 'Nextcloud ha rifiutato la password dell\'app. Accedi di nuovo.',
		'Tracker could not use your Keychain': 'Tracker non è riuscito a usare il Portachiavi',
		'You stay logged in until you quit Tracker; the password is not saved. To fix it, quit Tracker and open it again.': 'Resti connesso finché non chiudi Tracker; la password non viene salvata. Per risolvere, chiudi Tracker e riaprilo.',
		// notifications (same texts as the web page)
		'{name}: block ends soon': '{name}: il blocco sta per finire',
		'{minutes} min left. Unchecked subtasks move to the next block.': 'Mancano {minutes} min. I sottotask non spuntati passano al prossimo blocco.',
		'Step away for {minutes} min. The timer keeps running.': 'Staccati per {minutes} min. Il timer continua.',
		'Back to focus': 'Torna a concentrarti',
		'Time for a long break': 'È ora di una pausa lunga',
		'Tracking stopped. Back to work in {minutes} min.': 'Registrazione fermata. Si riprende tra {minutes} min.',
		'Break is over': 'La pausa è finita',
		'Press play to start the next focus session.': 'Premi play per iniziare la prossima sessione di concentrazione.',
	}

	function make(locale) {
		const dict = String(locale || '').toLowerCase().startsWith('it') ? it : {}
		return (s, vars) => String(dict[s] ?? s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m))
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = { make }
	else root.trackerI18n = { make }
})(typeof window !== 'undefined' ? window : globalThis)
