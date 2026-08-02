import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Cl5Follow } from '../src/cl5.js'
import { parseMappings } from '../src/mapping.js'

/** A follow instance wired up without a socket: `_send` is captured instead. */
function fakeFollow(text) {
	const follow = new Cl5Follow(() => {})
	follow.mappings = parseMappings(text)
	follow.sent = []
	follow._send = (line) => follow.sent.push(line)
	return follow
}

test('polls the right RCP parameter for each source type', () => {
	const follow = fakeFollow('33=Vox 1\nmix3=Aux\nmtx2=Lobby\ndca8=Band\nmute2=Choir')
	follow._poll()

	assert.deepEqual(follow.sent, [
		'get MIXER:Current/InCh/Fader/On 32 0',
		'get MIXER:Current/Mix/Fader/On 2 0',
		'get MIXER:Current/Mtrx/Fader/On 1 0',
		'get MIXER:Current/DCA/Fader/On 7 0',
		'get MIXER:Current/MuteMaster/On 1 0',
	])
})

test('an unknown source type is not polled', () => {
	const follow = fakeFollow('33=Vox 1')
	follow.mappings.push({ kind: 'nonsense', num: 1, index: 0, track: 'X' })
	follow._poll()

	assert.equal(follow.sent.length, 1)
})

for (const [label, line, expected] of [
	['input channel', 'OK get "MIXER:Current/InCh/Fader/On" 32 0 0', { track: 'Vox 1', muted: true, label: 'ch 33' }],
	['mix bus', 'OK get "MIXER:Current/Mix/Fader/On" 2 0 0', { track: 'Aux', muted: true, label: 'MIX 3' }],
	['matrix', 'NOTIFY set "MIXER:Current/Mtrx/Fader/On" 1 0 1', { track: 'Lobby', muted: false, label: 'MTX 2' }],
	['DCA', 'OK get "MIXER:Current/DCA/Fader/On" 7 0 0', { track: 'Band', muted: true, label: 'DCA 8' }],
	// A mute group runs the other way: engaged (1) is what mutes the track.
	['mute group', 'OK get "MIXER:Current/MuteMaster/On" 1 0 1', { track: 'Choir', muted: true, label: 'MUTE 2' }],
]) {
	test(`reads back a ${label} reply`, () => {
		const follow = fakeFollow('33=Vox 1\nmix3=Aux\nmtx2=Lobby\ndca8=Band\nmute2=Choir')
		const seen = []
		follow.on('consoleState', (s) => seen.push(s))

		follow._onLine(line)
		assert.deepEqual(seen, [expected])
	})
}

test('a mix reply does not fire a matrix mapping, or the reverse', () => {
	const follow = fakeFollow('mix2=Aux\nmtx2=Lobby')
	const seen = []
	follow.on('consoleState', (s) => seen.push(s))

	// Same index on both buses - only the matching parameter may match.
	follow._onLine('OK get "MIXER:Current/Mtrx/Fader/On" 1 0 0')
	assert.deepEqual(
		seen.map((s) => s.track),
		['Lobby'],
	)

	follow._onLine('OK get "MIXER:Current/Mix/Fader/On" 1 0 0')
	assert.deepEqual(
		seen.map((s) => s.track),
		['Lobby', 'Aux'],
	)
})

test('an unchanged value is not re-applied to Pro Tools', () => {
	const follow = fakeFollow('mix3=Aux')
	const seen = []
	follow.on('consoleState', (s) => seen.push(s))

	follow._onLine('OK get "MIXER:Current/Mix/Fader/On" 2 0 0')
	follow._onLine('OK get "MIXER:Current/Mix/Fader/On" 2 0 0')
	assert.equal(seen.length, 1, 'second identical reply is ignored')

	follow._onLine('NOTIFY set "MIXER:Current/Mix/Fader/On" 2 0 1')
	assert.equal(seen.length, 2, 'a genuine change fires')
	assert.equal(seen[1].muted, false)
})

test('a mute group is the inverse of a fader, both ways round', () => {
	const follow = fakeFollow('mute2=Choir\ndca2=Band')
	const seen = []
	follow.on('consoleState', (s) => s && seen.push(s))

	// Same value on both parameters, opposite meaning for Pro Tools.
	follow._onLine('OK get "MIXER:Current/MuteMaster/On" 1 0 1')
	follow._onLine('OK get "MIXER:Current/DCA/Fader/On" 1 0 1')
	assert.deepEqual(
		seen.map((s) => [s.label, s.muted]),
		[
			['MUTE 2', true],
			['DCA 2', false],
		],
	)

	follow._onLine('NOTIFY set "MIXER:Current/MuteMaster/On" 1 0 0')
	follow._onLine('NOTIFY set "MIXER:Current/DCA/Fader/On" 1 0 0')
	assert.deepEqual(
		seen.slice(2).map((s) => [s.label, s.muted]),
		[
			['MUTE 2', false],
			['DCA 2', true],
		],
	)
})

test('a parameter that is not mapped is ignored', () => {
	const follow = fakeFollow('mix3=Aux')
	const seen = []
	follow.on('consoleState', (s) => seen.push(s))

	follow._onLine('OK get "MIXER:Current/Mix/Fader/Level" 2 0 -3200')
	follow._onLine('OK get "MIXER:Current/Mix/Fader/On" 9 0 0')
	assert.deepEqual(seen, [])
})
