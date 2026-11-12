// What changed, newest first, for the Download page. The downloads are
// rolling builds from main (mac-latest, latest, nextcloud-latest); add an
// entry here when something visible changes.
import type { Text } from '../i18n'

export type Release = { date: string; title: Text; version?: string; items: Text[] }

export const CHANGELOG: Release[] = [
	{
		date: '2026-11-12',
		version: '0.7.0',
		title: { en: 'Back up everything, and bring it anywhere', it: 'Backup di tutto, da portare ovunque' },
		items: [
			{ en: 'Settings → Your data: export everything to one file, encrypted with a passphrase if you like, and import it on any device; it is merged like a sync and never deletes anything.', it: 'Impostazioni → I tuoi dati: esporta tutto in un file, cifrato con una passphrase se vuoi, e importalo su qualsiasi dispositivo; viene unito come in una sincronizzazione e non elimina mai nulla.' },
			{ en: 'Android: Export CSV works (it saved nothing before), and saving or opening a file uses the phone’s own file picker.', it: 'Android: Esporta CSV funziona (prima non salvava nulla), e salvare o aprire un file usa il selettore di file del telefono.' },
			{ en: 'Mac: files are saved and opened with macOS’s own dialogs.', it: 'Mac: i file si salvano e si aprono con le finestre di macOS.' },
			{ en: 'The Android app now has the same version number as the others.', it: 'L’app per Android ora ha lo stesso numero di versione delle altre.' },
		],
	},
	{
		date: '2026-11-11',
		title: { en: 'Blockwise in the browser, and a new look', it: 'Blockwise nel browser e un nuovo aspetto' },
		items: [
			{ en: 'Blockwise in the browser at /app/, with no server: your data stays in the browser, encrypted; optional Dropbox sync, end-to-end encrypted.', it: 'Blockwise nel browser su /app/, senza server: i dati restano nel browser, cifrati; sincronizzazione facoltativa con Dropbox, cifrata end-to-end.' },
			{ en: 'Android works on its own, with Nextcloud optional, and can sync through Dropbox or Google Drive, end-to-end encrypted.', it: 'Android funziona da solo, con Nextcloud facoltativo, e può sincronizzare tramite Dropbox o Google Drive, cifrati end-to-end.' },
			{ en: 'Drive sync notices changes from your other devices; encryption is optional and on by default.', it: 'La sincronizzazione con i drive vede le modifiche degli altri dispositivi; la cifratura è facoltativa e attiva per impostazione predefinita.' },
			{ en: 'Now shows the commitments as goal rings; Tasks shows one column per commitment.', it: 'Adesso mostra gli impegni come anelli degli obiettivi; Task mostra una colonna per impegno.' },
			{ en: 'The Timeline look on every page, with Poppins; Settings let you choose Automatic, Light or Dark.', it: 'L’aspetto Timeline su ogni pagina, con Poppins; nelle Impostazioni scegli Automatico, Chiaro o Scuro.' },
			{ en: 'Started earlier? Move the start of the running timer back.', it: 'Iniziato prima? Sposta indietro l’inizio del timer in corso.' },
		],
	},
	{
		date: '2026-11-10',
		version: '0.6.0',
		title: { en: 'Calendars, the Mac app and notes', it: 'Calendari, l’app per Mac e note' },
		items: [
			{ en: 'With Nextcloud, blocks are events in Nextcloud Calendar.', it: 'Con Nextcloud, i blocchi sono eventi in Calendario di Nextcloud.' },
			{ en: 'A built-in calendar for blocks, so Apple Calendar is optional on the Mac.', it: 'Un calendario integrato per i blocchi, così sul Mac Calendario di Apple è facoltativo.' },
			{ en: 'The Mac app syncs with Nextcloud, Dropbox or Google Drive (end-to-end encrypted), or keeps everything on the Mac; switching takes your data along.', it: 'L’app per Mac sincronizza con Nextcloud, Dropbox o Google Drive (cifrati end-to-end) o tiene tutto sul Mac; cambiando, i dati vengono con te.' },
			{ en: 'Notes per commitment, in Markdown with a formatting editor and checklists you can tick.', it: 'Note per ogni impegno, in Markdown con un editor di formattazione e liste da spuntare.' },
			{ en: 'The app is now called Blockwise, with a new icon: two stacked blocks.', it: 'L’app ora si chiama Blockwise, con una nuova icona: due blocchi impilati.' },
		],
	},
	{
		date: '2026-11-08',
		title: { en: 'Local-first on Android', it: 'Android local-first' },
		items: [
			{ en: 'The Android app runs on the phone and syncs with Nextcloud when it can.', it: 'L’app per Android funziona sul telefono e sincronizza con Nextcloud quando può.' },
			{ en: 'Material 3 design, with your wallpaper’s colors.', it: 'Design Material 3, con i colori del tuo sfondo.' },
			{ en: 'Signed release builds and reminders on the lock screen.', it: 'Versioni firmate e promemoria sulla schermata di blocco.' },
		],
	},
	{
		date: '2026-11-07',
		title: { en: 'The first Android app', it: 'La prima app per Android' },
		items: [
			{ en: 'Blockwise (then called Tracker) on Android, working with the Nextcloud app.', it: 'Blockwise (allora Tracker) su Android, insieme all’app per Nextcloud.' },
		],
	},
]
