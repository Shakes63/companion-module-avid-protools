import { test } from 'node:test'
import assert from 'node:assert/strict'

import Instance from '../src/main.js'
import {
	MAP_COUNT_ID,
	MAX_MAP_ROWS,
	SOURCE_COUNTS,
	mapRowFields,
	mappingWarnings,
	mappingsFromRows,
	parseMappings,
	rowIds,
	rowsFromMappings,
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

/** A settled config holding `text`'s mappings in the rows. */
function settled(text) {
	return rowsFromMappings(parseMappings(text))
}

test('parsed mappings survive a trip through the rows', () => {
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

test('a source number the console does not have is warned about', () => {
	assert.deepEqual(mappingWarnings(parseMappings('33=Vox 1\nmix24=Aux\ndca16=Band')), [], 'in-range is quiet')

	const warnings = mappingWarnings(parseMappings(`mtx${SOURCE_COUNTS.mtx + 1}=Lobby`))
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /Matrix 9 \("Lobby"\) is beyond the 8/)
})

test('an empty config settles without a save loop', () => {
	const inst = fakeInstance({})
	assert.deepEqual(inst.syncMappingConfig(), [])
	assert.equal(inst.config[MAP_COUNT_ID], 1, 'one empty row is offered')
	assert.equal(inst.saved.length, 1)

	const before = JSON.stringify(inst.config)
	inst.syncMappingConfig()
	assert.equal(JSON.stringify(inst.config), before)
	assert.equal(inst.saved.length, 1, 'second pass writes nothing')
})

test('a legacy text mapping is imported once, then the text is cleared', () => {
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
	assert.equal(inst.config[rowIds(1).trk], 'Band')
	assert.equal(inst.config[MAP_COUNT_ID], 2)
	assert.equal(inst.config.cl5Map, '', 'the retired text field is emptied')
	assert.match(inst.logs.join('\n'), /Imported 2 console mappings/)

	// The import must not repeat or undo itself on the next load.
	const before = JSON.stringify(inst.config)
	assert.deepEqual(inst.syncMappingConfig(), mappings)
	assert.equal(JSON.stringify(inst.config), before)
})

test('adding a mapping is a new row plus a bumped count', () => {
	const inst = fakeInstance(settled('33=Vox 1'))
	inst.config[MAP_COUNT_ID] = 2 // what stepping the Mappings field up does
	inst.config[rowIds(1).src] = 'dca'
	inst.config[rowIds(1).num] = 8
	inst.config[rowIds(1).trk] = 'Band'

	assert.deepEqual(
		inst.syncMappingConfig().map((m) => [m.kind, m.num, m.track]),
		[
			['ch', 33, 'Vox 1'],
			['dca', 8, 'Band'],
		],
	)
	assert.equal(inst.config[MAP_COUNT_ID], 2)
})

test('stepping the count down removes the last mapping for good', () => {
	const inst = fakeInstance(settled('33=Vox 1\ndca8=Band'))
	assert.equal(inst.config[MAP_COUNT_ID], 2)

	inst.config[MAP_COUNT_ID] = 1
	assert.deepEqual(
		inst.syncMappingConfig().map((m) => m.track),
		['Vox 1'],
		'the hidden row must not keep firing',
	)
	assert.equal(inst.config[rowIds(1).src], '', 'and its values are cleared, not left lurking')
	assert.equal(inst.config[rowIds(1).trk], '')
})

test('emptying a row in the middle closes the gap', () => {
	const inst = fakeInstance(settled('33=Vox 1\ndca8=Band\nmix3=Aux'))
	inst.config[rowIds(1).trk] = '' // user cleared the middle mapping's track

	assert.deepEqual(
		inst.syncMappingConfig().map((m) => m.track),
		['Vox 1', 'Aux'],
	)
	assert.equal(inst.config[rowIds(1).trk], 'Aux', 'the row below moved up')
	assert.equal(inst.config[rowIds(2).src], '', 'and the tail was blanked')
	assert.equal(inst.config[MAP_COUNT_ID], 2)
})

test('a legacy text mapping too long for the editor is truncated loudly', () => {
	const many = Array.from({ length: MAX_MAP_ROWS + 3 }, (_, i) => `${i + 1}=T${i + 1}`).join('\n')
	const inst = fakeInstance({ cl5Map: many })

	assert.equal(inst.syncMappingConfig().length, MAX_MAP_ROWS)
	assert.match(inst.logs.join('\n'), new RegExp(`the last 3 were dropped`))
	assert.equal(inst.config[MAP_COUNT_ID], MAX_MAP_ROWS)
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
	assert.equal(
		fields.filter((f) => f.type === 'textinput' && f.id === 'cl5Map').length,
		0,
		'the text mapping field is gone',
	)
	for (const f of fields) {
		assert.ok(f.width > 0 && f.width <= 12, `bad width on ${f.id}`)
		assert.ok(f.label?.length, `missing label on ${f.id}`)
	}

	// Each mapping row is 3 + 2 + 7, so it lands on one 12-wide line.
	const row = mapRowFields([]).slice(1, 4)
	assert.equal(
		row.reduce((sum, f) => sum + f.width, 0),
		12,
	)
})

test('rows past the count are hidden, and row 1 always shows', () => {
	const fields = mapRowFields([])
	const count = fields.find((f) => f.id === MAP_COUNT_ID)

	assert.ok(count, 'the count field exists')
	assert.equal(count.disableAutoExpression, true, 'must not be expression-capable to be referenced')
	assert.equal(count.min, 1)
	assert.equal(count.max, MAX_MAP_ROWS)

	// Row 1 carries no expression, so a broken expression engine still leaves a
	// usable panel rather than an empty one.
	for (const id of Object.values(rowIds(0))) {
		assert.equal(fields.find((f) => f.id === id).isVisibleExpression, undefined, `${id} should always show`)
	}

	// Every later row hides until the count reaches it. All three of its fields
	// must agree, or a row would show up half-rendered.
	for (let i = 1; i < MAX_MAP_ROWS; i++) {
		for (const id of Object.values(rowIds(i))) {
			assert.equal(
				fields.find((f) => f.id === id).isVisibleExpression,
				`$(options:${MAP_COUNT_ID}) > ${i}`,
				`wrong visibility on ${id}`,
			)
		}
	}
})
