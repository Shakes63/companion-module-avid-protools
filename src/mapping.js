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

/**
 * Source types, in the order they appear in the dropdown.
 *
 * `prefix` is how the type is written in the text format — input channels stay
 * bare (`33=Vox 1`) so mappings written before the other types existed keep
 * their exact spelling. `count` is how many of that type a CL/QL carries, used
 * only to warn about an out-of-range number.
 */
const SOURCES = {
	ch: { label: 'Input channel', prefix: '', count: 72 },
	mix: { label: 'Mix bus', prefix: 'mix', count: 24 },
	mtx: { label: 'Matrix', prefix: 'mtx', count: 8 },
	dca: { label: 'DCA', prefix: 'dca', count: 16 },
}

/** Text-format prefixes accepted on input, including a few spellings that are
 *  easier to guess than the canonical one. */
const PREFIX_ALIASES = {
	ch: 'ch',
	in: 'ch',
	inch: 'ch',
	mix: 'mix',
	mtx: 'mtx',
	matrix: 'mtx',
	dca: 'dca',
}

const SRC_CHOICES = [
	{ id: SRC_UNUSED, label: '- unused -' },
	...Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label })),
]

/** The highest source number a CL/QL has of each type. */
export const SOURCE_COUNTS = Object.fromEntries(Object.entries(SOURCES).map(([id, s]) => [id, s.count]))

/** Config field ids for editor row `i`. */
export function rowIds(i) {
	return { src: `cl5Src${i}`, num: `cl5Num${i}`, trk: `cl5Trk${i}` }
}

/**
 * Parse the mapping text.
 * Lines look like:  33=Vox 1  |  mix3=Aux  |  mtx2=Lobby  |  dca8=Band  |  # comment
 * A bare number is an input channel.
 * Returns [{ kind:'ch'|'mix'|'mtx'|'dca', num, index, track }]
 */
export function parseMappings(text) {
	const out = []
	for (const rawLine of String(text ?? '').split(/[\n,]/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const m = line.match(/^([a-z]+)?\s*(\d+)\s*=\s*(.+)$/i)
		if (!m) continue
		const kind = m[1] ? PREFIX_ALIASES[m[1].toLowerCase()] : 'ch'
		if (!kind) continue
		const num = parseInt(m[2], 10)
		const track = m[3].trim()
		if (!num || !track) continue
		out.push({ kind, num, index: num - 1, track })
	}
	return out
}

/** Render mappings back to the text format `parseMappings` reads. */
export function serializeMappings(mappings) {
	return mappings.map((m) => `${SOURCES[m.kind]?.prefix ?? ''}${m.num}=${m.track}`).join('\n')
}

/** Human-readable complaints about a mapping set, e.g. a matrix number a CL/QL
 *  does not have. Advisory only — the mapping still runs. */
export function mappingWarnings(mappings) {
	const out = []
	for (const m of mappings) {
		const src = SOURCES[m.kind]
		if (!src) continue
		if (m.num > src.count) {
			out.push(
				`${src.label} ${m.num} ("${m.track}") is beyond the ${src.count} a CL/QL has - the console will ignore it`,
			)
		}
	}
	return out
}

/** Collect the filled-in editor rows, in row order. */
export function mappingsFromRows(config) {
	const out = []
	for (let i = 0; i < MAX_MAP_ROWS; i++) {
		const ids = rowIds(i)
		const kind = String(config?.[ids.src] ?? '')
		if (!SOURCES[kind]) continue
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
				tooltip: `On a CL/QL: ${Object.values(SOURCES)
					.map((s) => `${s.label} 1-${s.count}`)
					.join(', ')}`,
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
