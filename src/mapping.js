/**
 * Console -> Pro Tools track mapping.
 *
 * Two representations of the same thing:
 *
 * - **text** (`33=Vox 1`, one rule per line) — the storage/exchange format, so
 *   mappings still import and export as plain text, comments and all.
 * - **rows** — the editor. Companion config has no repeating-row control, so it
 *   is a fixed block of rows built from dropdowns; a row set to "unused" is
 *   simply skipped.
 *
 * `main.js` reconciles the two on every config change.
 */

/** How many editor rows the config page shows. Larger setups can still use the
 *  text field, which stays authoritative when it holds more rules than this. */
export const MAX_MAP_ROWS = 16

const SRC_UNUSED = ''

const SRC_CHOICES = [
	{ id: SRC_UNUSED, label: '- unused -' },
	{ id: 'ch', label: 'Input channel' },
	{ id: 'dca', label: 'DCA' },
]

/** Config field ids for editor row `i`. */
export function rowIds(i) {
	return { src: `cl5Src${i}`, num: `cl5Num${i}`, trk: `cl5Trk${i}` }
}

/**
 * Parse the mapping text.
 * Lines look like:  33=Vox 1   |   dca8=Band   |   # comment
 * Returns [{ kind:'ch'|'dca', num, index, track }]
 */
export function parseMappings(text) {
	const out = []
	for (const rawLine of String(text ?? '').split(/[\n,]/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const m = line.match(/^(dca\s*)?(\d+)\s*=\s*(.+)$/i)
		if (!m) continue
		const isDca = !!m[1]
		const num = parseInt(m[2], 10)
		const track = m[3].trim()
		if (!num || !track) continue
		out.push({ kind: isDca ? 'dca' : 'ch', num, index: num - 1, track })
	}
	return out
}

/** Render mappings back to the text format `parseMappings` reads. */
export function serializeMappings(mappings) {
	return mappings.map((m) => `${m.kind === 'dca' ? 'dca' : ''}${m.num}=${m.track}`).join('\n')
}

/** Collect the filled-in editor rows, in row order. */
export function mappingsFromRows(config) {
	const out = []
	for (let i = 0; i < MAX_MAP_ROWS; i++) {
		const ids = rowIds(i)
		const kind = String(config?.[ids.src] ?? '')
		if (kind !== 'ch' && kind !== 'dca') continue
		const num = parseInt(config?.[ids.num], 10)
		const track = String(config?.[ids.trk] ?? '').trim()
		if (!num || num < 1 || !track) continue
		out.push({ kind, num, index: num - 1, track })
	}
	return out
}

/** Config patch that lays `mappings` out across the editor rows, clearing the
 *  rest. Callers must keep `mappings.length <= MAX_MAP_ROWS`. */
export function rowsFromMappings(mappings) {
	const patch = {}
	for (let i = 0; i < MAX_MAP_ROWS; i++) {
		const ids = rowIds(i)
		const m = mappings[i]
		patch[ids.src] = m ? m.kind : SRC_UNUSED
		patch[ids.num] = m ? m.num : 1
		patch[ids.trk] = m ? m.track : ''
	}
	return patch
}

/**
 * Build the editor's config fields.
 *
 * `choices` is a snapshot of the session track list taken when the config page
 * was opened — the dropdowns allow a typed value so a track that is not in the
 * list (or not in the session yet) can still be mapped.
 */
export function mapRowFields(choices) {
	const fields = []
	for (let i = 0; i < MAX_MAP_ROWS; i++) {
		const ids = rowIds(i)
		fields.push(
			{
				type: 'dropdown',
				id: ids.src,
				label: `${i + 1}. Source`,
				width: 3,
				default: SRC_UNUSED,
				choices: SRC_CHOICES,
			},
			{
				type: 'number',
				id: ids.num,
				label: 'Number',
				width: 2,
				default: 1,
				min: 1,
				max: 128,
			},
			{
				type: 'dropdown',
				id: ids.trk,
				label: 'Pro Tools track',
				width: 7,
				default: '',
				choices,
				allowCustom: true,
			},
		)
	}
	return fields
}
