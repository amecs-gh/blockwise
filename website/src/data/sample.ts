// The example week the illustrations show: four commitments, their goals and
// what was tracked so far.
import type { Text } from '../i18n'

export type Sample = { id: string; color: string; name: Text; goal: number; done: number }

export const COMMITMENTS: Sample[] = [
	{ id: 'thesis', color: 'c-violet', name: { en: 'Thesis', it: 'Tesi' }, goal: 15, done: 9.5 },
	{ id: 'work', color: 'c-blue', name: { en: 'Work', it: 'Lavoro' }, goal: 20, done: 20.5 },
	{ id: 'teaching', color: 'c-orange', name: { en: 'Teaching', it: 'Didattica' }, goal: 6, done: 2 },
	{ id: 'running', color: 'c-green', name: { en: 'Running', it: 'Corsa' }, goal: 0, done: 2.5 },
]
export const byId = (id: string) => COMMITMENTS.find((c) => c.id === id)!

/** A share rounded to the 5% steps the styles have (pct-*, from-*, goal-*) */
export const step = (x: number) => Math.max(0, Math.min(100, Math.round((x * 100) / 5) * 5))

/** Hours as the app writes them: 9h 30m, 20h, 45m */
export const hm = (h: number) => {
	const m = Math.round(h * 60)
	const hh = Math.floor(m / 60)
	const mm = m % 60
	return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`
}
