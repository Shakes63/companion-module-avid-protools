import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import Instance from '../src/main.js'

/** Stand-in for PtslClient that records whether its socket was closed. */
class StubClient extends EventEmitter {
	constructor(behaviour = {}) {
		super()
		this.connected = false
		this.closed = false
		this.behaviour = behaviour
		StubClient.made.push(this)
	}

	static made = []

	async connect() {
		if (this.behaviour.connectDelay) await this.behaviour.connectDelay
		if (this.behaviour.failConnect) throw new Error('refused')
		this.connected = true
	}

	async subscribeEvents() {
		return true
	}

	async getTracks() {
		return []
	}

	async getSessionName() {
		return 'stub'
	}

	close() {
		this.closed = true
		this.connected = false
	}
}

/** An instance wired to stub clients, with only the bits connect() touches. */
function fakeInstance(behaviourFor = () => ({})) {
	StubClient.made = []
	let n = 0
	const inst = Object.create(Instance.prototype)
	Object.assign(inst, {
		config: { host: '10.0.0.1', port: '31417', pollInterval: 10 },
		tracks: [],
		ptsl: null,
		cl5: null,
		mappings: [],
		pollTimer: null,
		reconnectTimer: null,
		connecting: false,
		configGeneration: 0,
		logs: [],
		log: (lvl, msg) => inst.logs.push(`${lvl}: ${msg}`),
		updateStatus: () => {},
		setVariableValues: () => {},
		checkFeedbacks: () => {},
		initDefinitions: () => {},
		startCl5: () => {},
		newPtslClient: () => new StubClient(behaviourFor(n++)),
	})
	return inst
}

function cleanup(inst) {
	if (inst.pollTimer) clearInterval(inst.pollTimer)
	if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer)
}

test('a second connect() while one is in flight does not open a second client', async () => {
	let releaseFirst
	const gate = new Promise((r) => (releaseFirst = r))
	const inst = fakeInstance((i) => (i === 0 ? { connectDelay: gate } : {}))

	const first = inst.connect()
	const second = inst.connect() // the queued reconnect timer firing
	releaseFirst()
	await Promise.all([first, second])

	assert.equal(StubClient.made.length, 1, 'only one client should ever be constructed')
	assert.equal(inst.ptsl, StubClient.made[0])
	assert.equal(StubClient.made[0].closed, false, 'and it stays open')
	cleanup(inst)
})

test('connect() is a no-op while a connection is already up', async () => {
	const inst = fakeInstance()
	await inst.connect()
	assert.equal(StubClient.made.length, 1)

	await inst.connect()
	assert.equal(StubClient.made.length, 1, 'no second client for an already-live connection')
	cleanup(inst)
})

test('a failed connect closes the client it created', async () => {
	const inst = fakeInstance(() => ({ failConnect: true }))
	await inst.connect()

	assert.equal(StubClient.made.length, 1)
	assert.equal(StubClient.made[0].closed, true, 'no orphaned socket')
	assert.equal(inst.ptsl, null)
	assert.ok(inst.reconnectTimer, 'and a retry is queued')
	cleanup(inst)
})

// The reported leak: cleanup used to act on this.ptsl rather than the client the
// call created, so whichever attempt lost the race left its socket open on the
// Pro Tools side, one per reconnect blip, until Companion restarted.
test('a superseded connect closes its own client instead of stranding it', async () => {
	let releaseFirst
	const gate = new Promise((r) => (releaseFirst = r))
	const inst = fakeInstance((i) => (i === 0 ? { connectDelay: gate } : {}))

	const first = inst.connect()
	// A config change retires the in-flight attempt and starts a fresh one.
	inst.configGeneration++
	inst.connecting = false
	inst.ptsl = null
	const second = inst.connect()
	releaseFirst()
	await Promise.all([first, second])

	const [stale, current] = StubClient.made
	assert.equal(StubClient.made.length, 2)
	assert.equal(stale.closed, true, 'the retired attempt must close its own socket')
	assert.equal(inst.ptsl, current, 'and must not clobber the connection that replaced it')
	assert.equal(current.closed, false)
	cleanup(inst)
})

test('reconnecting does not strand the previous poll timer', async () => {
	const inst = fakeInstance()
	await inst.connect()
	const firstTimer = inst.pollTimer
	assert.ok(firstTimer)

	// Simulate the connection dropping and coming back.
	inst.ptsl = null
	await inst.connect()

	assert.notEqual(inst.pollTimer, firstTimer, 'a new timer is running')
	// An uncleared interval keeps polling forever and drives reconnects of its
	// own, which is what turned one leak into a compounding one.
	assert.equal(firstTimer._destroyed, true, 'and the old one was cleared')
	cleanup(inst)
})

test('refreshTracks failing does not close a client that has replaced it', async () => {
	const inst = fakeInstance()
	await inst.connect()
	const original = inst.ptsl

	// A newer client is installed while the old one's getTracks is in flight.
	const replacement = new StubClient()
	replacement.connected = true
	original.getTracks = async () => {
		inst.ptsl = replacement
		throw new Error('dropped')
	}
	inst.ptsl = original
	await inst.refreshTracks()

	assert.equal(original.closed, true, 'the failed client is closed')
	assert.equal(replacement.closed, false, 'the replacement is left alone')
	assert.equal(inst.ptsl, replacement)
	cleanup(inst)
})
