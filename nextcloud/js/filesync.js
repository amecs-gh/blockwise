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
 * Everything is end-to-end encrypted: a key made from your passphrase
 * (PBKDF2-SHA-256, 600 000 rounds, random salt) encrypts each file with
 * AES-256-GCM. The file's name is bound into the encryption, so files can't be
 * swapped or altered unnoticed. The drive only ever sees random-looking bytes;
 * "blockwise.json" holds the salt and a check value (no secrets).
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

	/**
	 * Sets up the folder (first device) or checks the passphrase against it.
	 * @return {Promise<Uint8Array>} the key, to keep on this device (encrypted by the system)
	 */
	async function unlock(store, passphrase) {
		let info = await readInfo(store)
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
		const k = info && info.kdf
		if (!info || info.format !== 1 || !k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || typeof k.salt !== 'string' || typeof info.check !== 'string'
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
		const key = await importKey(o.key)
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
			const body = JSON.parse(dec.decode(await open(key, f.name, data)))
			if (!body || body.node !== f.node || body.n !== f.n || !Array.isArray(body.records) || body.records.length > MAX_RECORDS * 4) {
				throw new SyncError('A sync file does not match its name', 'damaged')
			}
			return body
		}

		/** Writes records as this device's next file. */
		async function push(records) {
			if (!Array.isArray(records) || !records.length) return { applied: 0, rejected: [] }
			const mine = (await listLogs()).filter((f) => f.node === o.node)
			let n = mine.length ? mine[mine.length - 1].n + 1 : 1
			for (let i = 0; i < records.length; i += MAX_RECORDS) {
				const body = { node: o.node, n, records: records.slice(i, i + MAX_RECORDS) }
				const name = fileName(o.node, n)
				await o.store.write(name, await seal(key, name, enc.encode(JSON.stringify(body))), { create: true })
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
			await o.store.write(name, await seal(key, name, enc.encode(JSON.stringify(body))), { create: true })
			for (const f of mine) await o.store.remove(f.name).catch(() => {})
		}

		/** The other devices' files not read yet (since 0: all of them again). */
		async function pull(since) {
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

		return { push, pull, compact, kind: 'files' }
	}

	const api = { unlock, createRemote, SyncError, _seal: seal, _open: open }
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	else root.BlockwiseFileSync = api
})(typeof window !== 'undefined' ? window : globalThis)
