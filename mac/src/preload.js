'use strict'
// Bridge between the app's windows and the main process (the windows never see the password).
const { contextBridge, ipcRenderer } = require('electron')

const call = async (channel, ...args) => {
	const r = await ipcRenderer.invoke(channel, ...args)
	if (r && r.error) {
		const e = new Error(r.error)
		e.status = r.status
		throw e
	}
	return r ? r.data : undefined
}

contextBridge.exposeInMainWorld('trackerApp', {
	getState: () => call('state'),
	onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
	api: (method, path, body) => call('api', method, path, body),
	refresh: () => call('refresh'),
	open: (view, hash) => call('open', view, hash),
	login: (server) => call('login', server),
	cancelLogin: () => call('cancelLogin'),
	reopenLogin: () => call('reopenLogin'),
	connectDrive: (provider) => call('connectDrive', provider),
	unlockDrive: (passphrase, encrypt = true) => call('unlockDrive', passphrase, encrypt !== false),
	useThisMac: () => call('useThisMac'),
	saveProviderKeys: (provider, keys) => call('saveProviderKeys', provider, keys),
	syncNow: () => call('syncNow'),
	menu: () => call('menu'),
	setHeight: (h) => ipcRenderer.send('popover:height', h),
	openCalendar: (ts) => call('openCalendar', ts),
	calendarMode: () => call('calendarMode'),
	setCalendarMode: (mode) => call('setCalendarMode', mode),
	accountCalendar: () => call('accountCalendar'),
	useAccountCalendar: (on) => call('useAccountCalendar', on === true),
	appearance: () => call('appearance'),
	setAppearance: (mode) => call('setAppearance', mode),
	onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
	saveFile: (name, text) => call('saveFile', name, text),
	openFile: () => call('openFile'),
})
