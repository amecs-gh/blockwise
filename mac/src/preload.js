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
	menu: () => call('menu'),
	setHeight: (h) => ipcRenderer.send('popover:height', h),
	openCalendar: (ts) => call('openCalendar', ts),
	onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
})
