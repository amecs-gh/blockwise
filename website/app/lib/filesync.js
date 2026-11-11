/*
 * Blockwise file sync: syncing through a folder on a drive (Dropbox app folder,
 * Google Drive app data), with no server. Used by the engine (js/engine.js) as
 * its `remote`, in place of Nextcloud's /api/sync.
 *
 * Each device writes its changes as numbered files of its own
 * ("log-<device>-<n>.bwx") and reads the other devices' new files; the engine
 * merges them per field (the later change wins) as it does with Nextcloud.
 * Files never change once written, so devices never overwrite each other.
 *
 * By default everything is end-to-end encrypted: a key made from your passphrase
 * (PBKDF2-SHA-256, 600 000 rounds, random salt) encrypts each file with
 * AES-256-GCM. The file's name is bound into the encryption, so files can't be
 * swapped or altered unnoticed. The drive only ever sees random-looking bytes;
 * "blockwise.json" holds the salt and a check value (no secrets).
 *
 * If you choose so when setting up the folder, it is not encrypted: the files
 * are plain JSON ("BWP1"), readable by the drive's provider; no passphrase.
 * blockwise.json says which; a device keeps the mode it joined with (the PLAIN
 * key) and refuses a folder that changed mode, so nobody with access to the
 * drive can switch an encrypted folder to plain text.
 *
 * The store is the drive, given by the app:
 *   list(): Promise<string[]>  names of the files in the folder
 *   read(name): Promise<Uint8Array|null>
 *   write(name, bytes, {create}): Promise<void>  create: fail if it exists (throws {exists: true})
 *   remove(name): Promise<void>
 *
 * Usable in browsers/WebViews (window.BlockwiseFileSync) and Node (require).
 */
;(function (root) {
	'use strict'

	const subtle = () => (root.crypto && root.crypto.subtle) || require('node:crypto').webcrypto.subtle
	const random = (n) => {
		const b = new Uint8Array(n)
		;(root.crypto || require('node:crypto').webcrypto).getRandomValues(b)
		return b
	}
	const enc = new TextEncoder()
	const dec = new TextDecoder()
	const b64 = (u8) => {
		let s = ''
		for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
		return (root.btoa || ((x) => Buffer.from(x, 'binary').toString('base64')))(s)
	}
	const unb64 = (s) => {
		const bin = (root.atob || ((x) => Buffer.from(x, 'base64').toString('binary')))(s)
		const u8 = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
		return u8
	}

	const INFO = 'blockwise.json'
	const MAGIC = [0x42, 0x57, 0x58, 0x31] // "BWX1"
	const ITERATIONS = 600000
	const MAX_FILE = 32 * 1024 * 1024
	const MAX_RECORDS = 5000
	const COMPACT_AFTER = 40 // own files before they're merged into one
	const LOG_RE = /^log-([A-Za-z0-9_-]{1,32})-(\d{9})\.bwx$/
	const CHECK = 'blockwise-key-check'
	const PLAIN_MAGIC = [0x42, 0x57, 0x50, 0x31] // "BWP1"
	/** The "key" a device keeps for a folder without encryption (32 bytes, like a real key) */
	const PLAIN_KEY = 'BLOCKWISE-UNENCRYPTED-FOLDER-V01'
	const plainKey = () => enc.encode(PLAIN_KEY)
	const isPlain = (key) => key instanceof Uint8Array && key.length === 32 && dec.decode(key) === PLAIN_KEY

	class SyncError extends Error {
		constructor(message, code) {
			super(message)
			this.code = code
		}
	}

	async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
		if (typeof passphrase !== 'string' || [...passphrase].length < 8) throw new SyncError('The passphrase needs at least 8 characters.', 'weak')
		const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
		return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
	}
	const importKey = (raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
	const exportKey = async (key) => new Uint8Array(await subtle().exportKey('raw', key))

	/** "BWX1" + 12-byte IV + AES-GCM(ciphertext + tag); the file name is the additional data. */
	async function seal(key, name, bytes) {
		const iv = random(12)
		const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, key, bytes))
		const out = new Uint8Array(4 + 12 + ct.length)
		out.set(MAGIC, 0)
		out.set(iv, 4)
		out.set(ct, 16)
		return out
	}
	async function open(key, name, data) {
		if (!(data instanceof Uint8Array) || data.length < 4 + 12 + 16 || data.length > MAX_FILE || MAGIC.some((b, i) => data[i] !== b)) {
			throw new SyncError('Not a Blockwise file', 'damaged')
		}
		try {
			return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: data.slice(4, 16), additionalData: enc.encode(name) }, key, data.slice(16)))
		} catch (e) {
			throw new SyncError('A file could not be decrypted (wrong passphrase, or changed by someone else)', 'decrypt')
		}
	}

	/** Is there a Blockwise folder, and is it encrypted? (Before asking for a passphrase.) */
	async function inspect(store) {
		const info = await readInfo(store)
		return { exists: !!info, encrypted: !info || info.encryption !== 'none' }
	}

	/**
	 * Sets up the folder (first device) or checks the passphrase against it.
	 * `encrypt: false` sets up a new folder without encryption (no passphrase);
	 * a folder made that way opens without one.
	 * @return {Promise<Uint8Array>} the key, to keep on this device (encrypted by the system)
	 */
	async function unlock(store, passphrase, opts = {}) {
		let info = await readInfo(store)
		if (!info && opts.encrypt === false) {
			try {
				await store.write(INFO, enc.encode(JSON.stringify({ format: 1, app: 'blockwise', encryption: 'none' }, null, '\t')), { create: true })
				return plainKey()
			} catch (e) {
				if (!e || !e.exists) throw e
				info = await readInfo(store) // another device set it up at the same moment: use theirs
				if (!info) throw new SyncError('The sync folder could not be read.', 'folder')
			}
		}
		if (info && info.encryption === 'none') return plainKey()
		if (!info) {
			const salt = random(16)
			const key = await deriveKey(passphrase, salt)
			const fresh = { format: 1, app: 'blockwise', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) }, check: b64(await seal(key, INFO, enc.encode(CHECK))) }
			try {
				await store.write(INFO, enc.encode(JSON.stringify(fresh, null, '\t')), { create: true })
				return exportKey(key)
			} catch (e) {
				if (!e || !e.exists) throw e
				info = await readInfo(store) // another device set it up at the same moment: use theirs
				if (!info) throw new SyncError('The sync folder could not be read.', 'folder')
			}
		}
		const key = await deriveKey(passphrase, unb64(info.kdf.salt), info.kdf.iterations)
		try {
			if (dec.decode(await open(key, INFO, unb64(info.check))) !== CHECK) throw new Error('check')
		} catch (e) {
			throw new SyncError('Wrong passphrase for this sync folder.', 'passphrase')
		}
		return exportKey(key)
	}

	async function readInfo(store) {
		const data = await store.read(INFO)
		if (!data) return null
		let info
		try {
			info = JSON.parse(dec.decode(data))
		} catch (e) {
			throw new SyncError('The sync folder is damaged (blockwise.json).', 'folder')
		}
		if (info && info.format === 1 && info.encryption === 'none' && !info.kdf && !info.check) return info
		const k = info && info.kdf
		if (!info || info.format !== 1 || info.encryption !== undefined || !k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || typeof k.salt !== 'string' || typeof info.check !== 'string'
			|| !Number.isInteger(k.iterations) || k.iterations < 100000 || k.iterations > 10000000) {
			throw new SyncError('The sync folder was made by another version of Blockwise.', 'folder')
		}
		return info
	}

	const fileName = (node, n) => `log-${node}-${String(n).padStart(9, '0')}.bwx`

	/**
	 * The engine's `remote` over a drive folder.
	 * @param {object} o
	 * @param {object} o.store the folder (see above)
	 * @param {Uint8Array} o.key from unlock()
	 * @param {string} o.node this device's id (letters, digits, - and _)
	 * @param {{load(): Promise<object|null>, save(state: object): Promise<void>}} [o.state] what this device has read already
	 */
	async function createRemote(o) {
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(o.node)) throw new SyncError('Invalid device id', 'node')
		const plain = isPlain(o.key)
		// The folder must still be what this device joined: never write plain text into an encrypted
		// folder. Checked at the first sync (not here: the app opens offline too).
		let modeChecked = false
		const checkMode = async () => {
			if (modeChecked) return
			const info = await readInfo(o.store)
			if (info && (info.encryption === 'none') !== plain) throw new SyncError('The sync folder changed (encryption turned on or off elsewhere). Connect it again.', 'mode')
			modeChecked = true
		}
		const key = plain ? null : await importKey(o.key)
		const pack = async (name, bytes) => {
			if (!plain) return seal(key, name, bytes)
			const out = new Uint8Array(4 + bytes.length)
			out.set(PLAIN_MAGIC, 0)
			out.set(bytes, 4)
			return out
		}
		const unpack = async (name, data) => {
			if (!plain) return open(key, name, data)
			if (!(data instanceof Uint8Array) || data.length < 4 || data.length > MAX_FILE || PLAIN_MAGIC.some((b, i) => data[i] !== b)) throw new SyncError('Not a Blockwise file', 'damaged')
			return data.slice(4)
		}
		let state = (o.state && (await o.state.load())) || null
		if (!state || typeof state !== 'object' || typeof state.seen !== 'object') state = { seen: {}, cursor: 0 }
		const save = () => (o.state ? o.state.save(state) : Promise.resolve())

		const listLogs = async () => {
			const out = []
			for (const name of (await o.store.list()) || []) {
				const m = LOG_RE.exec(name)
				if (m) out.push({ name, node: m[1], n: Number(m[2]) })
			}
			out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : a.n - b.n))
			return out
		}
		const readLog = async (f) => {
			const data = await o.store.read(f.name)
			if (!data) return null
			const body = JSON.parse(dec.decode(await unpack(f.name, data)))
			if (!body || body.node !== f.node || body.n !== f.n || !Array.isArray(body.records) || body.records.length > MAX_RECORDS * 4) {
				throw new SyncError('A sync file does not match its name', 'damaged')
			}
			return body
		}

		/** Writes records as this device's next file. */
		async function push(records) {
			if (!Array.isArray(records) || !records.length) return { applied: 0, rejected: [] }
			await checkMode()
			const mine = (await listLogs()).filter((f) => f.node === o.node)
			let n = mine.length ? mine[mine.length - 1].n + 1 : 1
			for (let i = 0; i < records.length; i += MAX_RECORDS) {
				const body = { node: o.node, n, records: records.slice(i, i + MAX_RECORDS) }
				const name = fileName(o.node, n)
				await o.store.write(name, await pack(name, enc.encode(JSON.stringify(body))), { create: true })
				n++
			}
			if (mine.length + 1 > COMPACT_AFTER) await compact()
			return { applied: records.length, rejected: [] }
		}

		/**
		 * Merges this device's files into one (the latest value of each field,
		 * deletions kept), so a new device reads little. Others read it like any file.
		 */
		async function compact() {
			await checkMode()
			const mine = (await listLogs()).filter((f) => f.node === o.node)
			if (mine.length < 2) return
			const merged = new Map()
			for (const f of mine) {
				const body = await readLog(f)
				if (!body) continue
				for (const r of body.records) {
					const k = r.type + ':' + r.id
					if (r.deleted) { merged.set(k, { type: r.type, id: r.id, deleted: true }); continue }
					const cur = merged.get(k)
					if (cur && cur.deleted) continue
					const next = cur || { type: r.type, id: r.id, fields: {}, clock: {} }
					for (const [field, v] of Object.entries(r.fields || {})) {
						const c = (r.clock || {})[field] || ''
						if (!next.clock[field] || c >= next.clock[field]) { next.fields[field] = v; next.clock[field] = c }
					}
					merged.set(k, next)
				}
			}
			const last = mine[mine.length - 1].n + 1
			const records = [...merged.values()]
			// Written first, then the old files removed: a reader never misses anything
			const body = { node: o.node, n: last, records, base: true }
			const name = fileName(o.node, last)
			await o.store.write(name, await pack(name, enc.encode(JSON.stringify(body))), { create: true })
			for (const f of mine) await o.store.remove(f.name).catch(() => {})
		}

		/** The other devices' files not read yet (since 0: all of them again). */
		async function pull(since) {
			await checkMode()
			if (!since) state.seen = {}
			const records = []
			for (const f of await listLogs()) {
				if (f.node === o.node && since) continue // our own changes are here already
				if (f.n <= (state.seen[f.node] || 0)) continue
				const body = await readLog(f)
				if (!body) continue
				records.push(...body.records)
				state.seen[f.node] = f.n
			}
			state.cursor = (state.cursor || 0) + 1
			await save()
			return { cursor: state.cursor, more: false, reset: false, records }
		}

		return { push, pull, compact, kind: 'files', encrypted: !plain }
	}

	/**
	 * Watches the drive's folder and calls `onChange()` when another device
	 * wrote something, so it syncs at once instead of at the next round.
	 * The store gives changeCursor() and waitForChanges(cursor, {interval,
	 * sleep, signal}) -> {changed, cursor, retryAfter}: Dropbox waits on its
	 * side and answers at the change; Google Drive is asked every `interval`.
	 * Offline or busy: tries again later, more slowly each time (up to 5 min).
	 * @param {object} [o] interval(): ms between Google's checks (the app chooses:
	 *   sooner while you look at it); onError(e): the drive refused (log in again)
	 * @return {{stop(): void, poke(): void}} poke: check now (e.g. the window came back)
	 */
	function watch(store, onChange, o = {}) {
		if (!store || typeof store.changeCursor !== 'function' || typeof store.waitForChanges !== 'function') return { stop() {}, poke() {}, active: false }
		let stopped = false
		let ctrl = null
		let wake = null
		const sleep = (ms) => new Promise((resolve) => {
			const timer = setTimeout(() => { wake = null; resolve() }, ms)
			wake = () => { clearTimeout(timer); wake = null; resolve() }
		})
		;(async () => {
			let cursor = null
			let fails = 0
			while (!stopped) {
				try {
					if (!cursor) cursor = await store.changeCursor()
					ctrl = typeof AbortController === 'function' ? new AbortController() : null
					const interval = Math.max(5000, Number(o.interval ? o.interval() : 20000) || 20000)
					const r = await store.waitForChanges(cursor, { interval, sleep, signal: ctrl && ctrl.signal, timeout: 480 })
					if (stopped) break
					fails = 0
					if (r && typeof r.cursor === 'string') cursor = r.cursor
					if (r && r.changed) await onChange()
					if (r && r.retryAfter > 0) await sleep(r.retryAfter * 1000)
				} catch (e) {
					if (stopped) break
					if (e && (e.status === 401 || e.revoked)) { if (o.onError) o.onError(e); break }
					if (e && e.reset) cursor = null
					fails++
					await sleep(Math.min(300000, 15000 * 2 ** Math.min(fails - 1, 5)))
				}
			}
		})()
		return {
			active: true,
			stop() { stopped = true; if (ctrl) ctrl.abort(); if (wake) wake() },
			poke() { if (wake) wake() },
		}
	}

	const api = { unlock, inspect, createRemote, watch, SyncError, _seal: seal, _open: open }
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	else root.BlockwiseFileSync = api
})(typeof window !== 'undefined' ? window : globalThis)
