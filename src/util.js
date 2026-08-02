/** Turn a Pro Tools track name into a safe Companion variable id fragment. */
export function varSafe(name) {
	return String(name)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 40)
}

/** Build dropdown choices from the track list. */
export function trackChoices(tracks) {
	return tracks.map((t) => ({ id: t.name, label: `${t.index}. ${t.name}` }))
}
