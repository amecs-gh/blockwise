'use strict'
/**
 * Secrets and data on this Mac, encrypted with a key kept in the macOS Keychain
 * (Electron's safeStorage): the Nextcloud app password, the drive's refresh
 * token, the sync key and your Blockwise data. Nothing is ever written
 * unencrypted: without the Keychain it stays in memory for this run only.
 *
 * `safeStorage` is passed in, so this runs in tests without Electron.
 */
const fs = require('node:fs')
const path = require('node:path')

function createVault({ safeStorage, dir }) {
	const memory = new Map()

	async function seal(text) {
		try {
			if (await safeStorage.isAsyncEncryptionAvailable()) return (await safeStorage.encryptStringAsync(text)).toString('base64')
		} catch (e) {
			// Keychain refused: nothing is stored
		}
		return null
	}

	async function unseal(sealed) {
		if (typeof sealed !== 'string' || !sealed) return null
		const { result } = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))
		return result
	}

	const file = (name) => path.join(dir, `${name}.bin`)

	/** A whole file (the engine's data): null if missing; throws if the Keychain can't open it */
	async function read(name) {
		if (memory.has(name)) return memory.get(name)
		let sealed
		try { sealed = fs.readFileSync(file(name), 'utf8') } catch (e) { return null }
		return unseal(sealed)
	}

	/** Written atomically (a crash leaves the old or the new file, never half of one) */
	async function write(name, text) {
		const sealed = await seal(text)
		if (sealed === null) { memory.set(name, text); return false }
		memory.delete(name)
		fs.mkdirSync(dir, { recursive: true })
		const tmp = file(name) + '.tmp'
		fs.writeFileSync(tmp, sealed, { mode: 0o600 })
		fs.renameSync(tmp, file(name))
		return true
	}

	function remove(name) {
		memory.delete(name)
		try { fs.unlinkSync(file(name)) } catch (e) { /* not there */ }
	}

	return { seal, unseal, read, write, remove }
}

module.exports = { createVault }
