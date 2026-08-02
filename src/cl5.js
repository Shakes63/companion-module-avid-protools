import net from 'net'
import { EventEmitter } from 'events'

const RCP_PORT = 49280

/**
 * The RCP parameter to watch for each source type, keyed by the mapping `kind`,
 * with the console value that means the Pro Tools track should be muted.
 * Verified against the CL/QL parameter list.
 *
 * A fader's ON=1 means *unmuted*, so 0 is the muting value. A mute group master
 * is the other way round: ON=1 is the group actively muting its channels.
 */
const SOURCE_PARAM = {
	ch: { param: 'MIXER:Current/InCh/Fader/On', mutedWhen: 0, label: 'ch' },
	mix: { param: 'MIXER:Current/Mix/Fader/On', mutedWhen: 0, label: 'MIX' },
	mtx: { param: 'MIXER:Current/Mtrx/Fader/On', mutedWhen: 0, label: 'MTX' },
	dca: { param: 'MIXER:Current/DCA/Fader/On', mutedWhen: 0, label: 'DCA' },
	mute: { param: 'MIXER:Current/MuteMaster/On', mutedWhen: 1, label: 'MUTE' },
}

/** Match a parameter address from the console back to a mapping kind. */
function kindOfAddress(address) {
	for (const [kind, src] of Object.entries(SOURCE_PARAM)) {
		// Compare the distinctive tail so the `MIXER:Current` prefix can vary.
		if (address.endsWith(src.param.slice(src.param.indexOf('/')))) return kind
	}
	return null
}

/**
 * Mirrors Yamaha CL/QL channel, mix, matrix, DCA and mute group state onto Pro
 * Tools track mutes. Which console value counts as muted is per source type --
 * see SOURCE_PARAM above.
 *
 * We only act when a console value CHANGES (or on a forced resync), so manually
 * muting a track in Companion/Pro Tools stays put until the console next moves
 * -- manual control remains a usable override.
 */
export class Cl5Follow extends EventEmitter {
	constructor(log) {
		super()
		this.log = log
		this.socket = null
		this.connected = false
		this.enabled = false
		this.host = ''
		this.mappings = []
		this.pollMs = 400
		this.last = new Map() // key -> last console value (0/1)
		this.buf = ''
		this._pollTimer = null
		this._reconnectTimer = null
		this._closing = false
		this._forceApply = false
	}

	key(m) {
		return `${m.kind}:${m.index}`
	}

	start({ host, mappings, pollMs, enabled }) {
		this.stop()
		this._closing = false
		this.host = host
		this.mappings = mappings
		this.pollMs = Math.max(100, pollMs || 400)
		this.enabled = !!enabled
		if (!this.host || this.mappings.length === 0) {
			this.log('debug', 'CL5 follow not started (no host or no mappings)')
			return
		}
		this._connect()
	}

	stop() {
		this._closing = true
		for (const t of ['_pollTimer', '_reconnectTimer', '_forceTimer']) {
			if (this[t]) {
				clearInterval(this[t])
				clearTimeout(this[t])
				this[t] = null
			}
		}
		if (this.socket) {
			try {
				this.socket.destroy()
			} catch {
				/* ignore */
			}
			this.socket = null
		}
		this.connected = false
		this.last.clear()
	}

	/** Re-apply every mapped channel to Pro Tools on the next poll. */
	resync() {
		this._forceApply = true
		this.last.clear()
		this._poll()
		// Replies land within a few ms; drop the flag once the pass is in so we
		// go back to acting only on genuine console changes.
		if (this._forceTimer) clearTimeout(this._forceTimer)
		this._forceTimer = setTimeout(() => {
			this._forceApply = false
			this._forceTimer = null
		}, 1500)
	}

	setEnabled(on) {
		const was = this.enabled
		this.enabled = !!on
		this.emit('enabledChanged', this.enabled)
		// Turning sync back on should immediately match Pro Tools to the desk.
		if (!was && this.enabled) this.resync()
	}

	_connect() {
		this.socket = new net.Socket()
		this.socket.setNoDelay(true)

		this.socket.on('connect', () => {
			this.connected = true
			this.buf = ''
			this.log('info', `CL5 follow connected to ${this.host}:${RCP_PORT}`)
			this.emit('connectionChanged', true)
			this.resync() // startup sync
			this._pollTimer = setInterval(() => this._poll(), this.pollMs)
		})

		this.socket.on('data', (d) => this._onData(d))

		const drop = (why) => {
			if (this.connected) this.log('warn', `CL5 follow disconnected (${why})`)
			this.connected = false
			this.emit('connectionChanged', false)
			if (this._pollTimer) {
				clearInterval(this._pollTimer)
				this._pollTimer = null
			}
			if (this.socket) {
				try {
					this.socket.destroy()
				} catch {
					/* ignore */
				}
				this.socket = null
			}
			if (!this._closing && !this._reconnectTimer) {
				this._reconnectTimer = setTimeout(() => {
					this._reconnectTimer = null
					this._connect()
				}, 5000)
			}
		}

		this.socket.on('error', (e) => drop(e.message))
		this.socket.on('close', () => drop('closed'))
		this.socket.connect(RCP_PORT, this.host)
	}

	_send(line) {
		if (this.socket && this.connected) {
			try {
				this.socket.write(line + '\n')
			} catch (e) {
				this.log('debug', `CL5 write failed: ${e.message}`)
			}
		}
	}

	/** Ask the console for every mapped parameter. */
	_poll() {
		for (const m of this.mappings) {
			const src = SOURCE_PARAM[m.kind]
			if (src) this._send(`get ${src.param} ${m.index} 0`)
		}
	}

	_onData(chunk) {
		this.buf += chunk.toString()
		let nl
		while ((nl = this.buf.indexOf('\n')) !== -1) {
			const line = this.buf.slice(0, nl).trim()
			this.buf = this.buf.slice(nl + 1)
			if (line) this._onLine(line)
		}
	}

	/** Handles both poll replies (`OK get ...`) and pushed changes (`NOTIFY set ...`). */
	_onLine(line) {
		const p = line.split(/\s+/)
		if (p.length < 6) return
		const status = p[0].toUpperCase()
		if (status !== 'OK' && status !== 'NOTIFY') return
		const action = p[1]
		if (action !== 'get' && action !== 'set') return

		const address = p[2].replace(/"/g, '')
		const index = parseInt(p[3], 10)
		const val = parseInt(p[5], 10)
		if (Number.isNaN(index) || Number.isNaN(val)) return

		const kind = kindOfAddress(address)
		if (!kind) return

		const m = this.mappings.find((x) => x.kind === kind && x.index === index)
		if (!m) return

		const k = this.key(m)
		const prev = this.last.get(k)
		this.last.set(k, val)
		if (prev === val && !this._forceApply) return // no change -> leave PT alone

		const src = SOURCE_PARAM[kind]
		this.emit('consoleState', { track: m.track, muted: val === src.mutedWhen, label: `${src.label} ${m.num}` })
	}
}
