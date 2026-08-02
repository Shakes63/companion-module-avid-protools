import { test } from 'node:test'
import assert from 'node:assert/strict'

import Instance from '../src/main.js'
import {
	MAX_MAP_ROWS,
	SOURCE_COUNTS,
	mapRowFields,
	mappingWarnings,
	mappingsFromRows,
	parseMappings,
	rowIds,
	rowsFromMappings,
	serializeMappings,
} from '../src/mapping.js'

// The methods under test only touch config/tracks/log/saveConfig, so they can be
// exercised against a stand-in without booting a real Companion instance.
const syncMappingConfig = Instance.prototype.syncMappingConfig
const configTrackChoices = Instance.prototype.configTrackChoices
const getConfigFields = Instance.prototype.getConfigFields

function fakeInstance(config, tracks = []) {
	return {
		config,
		tracks,
		logs: [],
		saved: [],
		log(lvl, msg) {
			this.logs.push(`${lvl}: ${msg}`)
		},
		saveConfig(c) {
			this.saved.push(structuredClone(c))
		},
		syncMappingConfig,
		configTrackChoices,
		getConfigFields,
	}
}

/** A config as it looks once `text` has been adopted into the rows. */
function settled(text) {
	return { cl5Map: text, cl5MapAuto: text, ...rowsFromMappings(parseMappings(text)) }
}

test('text and rows round trip', () => {
	const text = '33=Vox 1\nmix3=Aux\nmtx2=Lobby\ndca8=Band\nmute2=Choir'
	const mappings = parseMappings(text)
	assert.deepEqual(
		mappings.map((m) => [m.kind, m.num, m.index, m.track]),
		[
			['ch', 33, 32, 'Vox 1'],
			['mix', 3, 2, 'Aux'],
			['mtx', 2, 1, 'Lobby'],
			['dca', 8, 7, 'Band'],
			['mute', 2, 1, 'Choir'],
		],
	)
	assert.equal(serializeMappings(mappings), text)
	assert.deepEqual(mappingsFromRows(rowsFromMappings(mappings)), mappings)
})

test('source prefixes accept the obvious spellings', () => {
	const kinds = (text) => parseMappings(text).map((m) => m.kind)

	assert.deepEqual(kinds('MIX3=A\nMtx2=B\nDCA8=C\nMute2=D'), ['mix', 'mtx', 'dca', 'mute'], 'case is ignored')
	assert.deepEqual(kinds('matrix2=A'), ['mtx'], 'matrix spells out')
	assert.deepEqual(kinds('mutegroup2=A\nmg2=B'), ['mute', 'mute'], 'mute group spells out, or abbreviates')
	assert.deepEqual(kinds('ch33=A\nin33=B\n33=C'), ['ch', 'ch', 'ch'], 'a bare number is an input channel')
	assert.deepEqual(kinds('mix 3 = A'), ['mix'], 'spaces around the prefix are fine')
	assert.deepEqual(kinds('bus3=A'), [], 'an unknown prefix is skipped, not guessed at')
})

test('input channels still serialise bare, so old mappings do not churn', () => {
	const text = '33=Vox 1\ndca8=Band'
	assert.equal(serializeMappings(parseMappings(text)), text)
})

test('a source number the console does not have is warned about', () => {
	assert.deepEqual(mappingWarnings(parseMappings('33=Vox 1\nmix24=Aux\ndca16=Band')), [], 'in-range is quiet')

	const warnings = mappingWarnings(parseMappings(`mtx${SOURCE_COUNTS.mtx + 1}=Lobby`))
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /Matrix 9 \("Lobby"\) is beyond the 8/)
})

test('an empty config settles without a save loop', () => {
	const inst = fakeInstance({ cl5Map: '' })
	assert.deepEqual(inst.syncMappingConfig(), [])
	assert.equal(inst.config.cl5MapAuto, '')
	assert.equal(inst.saved.length, 1)

	const before = JSON.stringify(inst.config)
	inst.syncMappingConfig()
	assert.equal(JSON.stringify(inst.config), before)
	assert.equal(inst.saved.length, 1, 'second pass writes nothing')
})

test('an existing text-only mapping is adopted into the rows', () => {
	const inst = fakeInstance({ cl5Map: '# FOH\n33=Vox 1\ndca8 = Band ' })
	const mappings = inst.syncMappingConfig()

	assert.deepEqual(
		mappings.map((m) => [m.kind, m.num, m.track]),
		[
			['ch', 33, 'Vox 1'],
			['dca', 8, 'Band'],
		],
	)
	assert.equal(inst.config[rowIds(0).src], 'ch')
	assert.equal(inst.config[rowIds(0).num], 33)
	assert.equal(inst.config[rowIds(0).trk], 'Vox 1')
	assert.equal(inst.config[rowIds(1).src], 'dca')
	assert.equal(inst.config[rowIds(1).trk], 'Band')
	assert.equal(inst.config[rowIds(2).src], '', 'unused rows are cleared')
	assert.equal(inst.config.cl5Map, '# FOH\n33=Vox 1\ndca8 = Band ', 'the text is left verbatim')

	// From here the rows own the text, which normalises once and then settles.
	assert.deepEqual(inst.syncMappingConfig(), mappings)
	assert.equal(inst.config.cl5Map, '33=Vox 1\ndca8=Band')
	const before = JSON.stringify(inst.config)
	inst.syncMappingConfig()
	assert.equal(JSON.stringify(inst.config), before)
})

test('editing a row rewrites the text field', () => {
	const inst = fakeInstance(settled('33=Vox 1'))
	inst.config[rowIds(1).src] = 'dca'
	inst.config[rowIds(1).num] = 8
	inst.config[rowIds(1).trk] = 'Band'

	assert.equal(inst.syncMappingConfig().length, 2)
	assert.equal(inst.config.cl5Map, '33=Vox 1\ndca8=Band')
})

test('hand-editing the text overrides the rows', () => {
	const inst = fakeInstance(settled('33=Vox 1'))
	inst.config.cl5Map = '7=Drums'

	assert.deepEqual(
		inst.syncMappingConfig().map((m) => [m.kind, m.num, m.track]),
		[['ch', 7, 'Drums']],
	)
	assert.equal(inst.config[rowIds(0).num], 7)
	assert.equal(inst.config[rowIds(0).trk], 'Drums')
	assert.equal(inst.config[rowIds(1).src], '')
})

test('clearing every row clears the text', () => {
	const inst = fakeInstance(settled('33=Vox 1'))
	inst.config[rowIds(0).src] = ''

	assert.deepEqual(inst.syncMappingConfig(), [])
	assert.equal(inst.config.cl5Map, '')
})

test('a mapping larger than the editor keeps the text authoritative', () => {
	const many = Array.from({ length: MAX_MAP_ROWS + 3 }, (_, i) => `${i + 1}=T${i + 1}`).join('\n')
	const inst = fakeInstance({ cl5Map: many })

	assert.equal(inst.syncMappingConfig().length, MAX_MAP_ROWS + 3, 'every rule still runs')
	assert.equal(inst.saved.length, 0, 'nothing is rewritten')
	assert.equal(inst.config.cl5Map, many)
	assert.match(inst.logs[0], new RegExp(`more than the ${MAX_MAP_ROWS} editor rows`))

	assert.equal(inst.syncMappingConfig().length, MAX_MAP_ROWS + 3, 'and stays that way on reload')
	assert.equal(inst.config.cl5Map, many)
})

test('track choices cover the session plus anything already mapped', () => {
	const inst = fakeInstance(rowsFromMappings(parseMappings('33=Ghost Track')), [
		{ index: 1, name: 'Vox 1' },
		{ index: 2, name: 'Band' },
	])

	assert.deepEqual(inst.configTrackChoices(), [
		{ id: 'Vox 1', label: 'Vox 1' },
		{ id: 'Band', label: 'Band' },
		{ id: 'Ghost Track', label: 'Ghost Track (not in session)' },
	])
})

test('config fields are well formed', () => {
	const inst = fakeInstance({}, [{ index: 1, name: 'Vox 1' }])
	const fields = inst.getConfigFields()
	const ids = fields.map((f) => f.id)

	assert.equal(new Set(ids).size, ids.length, 'ids are unique')
	assert.equal(fields.filter((f) => f.id.startsWith('cl5Src')).length, MAX_MAP_ROWS)
	for (const f of fields) {
		assert.ok(f.width > 0 && f.width <= 12, `bad width on ${f.id}`)
		assert.ok(f.label?.length, `missing label on ${f.id}`)
	}

	// Each mapping row is 3 + 2 + 7, so it lands on one 12-wide line.
	const row = mapRowFields([]).slice(0, 3)
	assert.equal(
		row.reduce((sum, f) => sum + f.width, 0),
		12,
	)
})
