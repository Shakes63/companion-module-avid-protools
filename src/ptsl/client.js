import { EventEmitter } from 'events'
import { fileURLToPath } from 'url'
import path from 'path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** PTSL protocol version spoken by this client. */
export const PTSL_VERSION = 5

/** Command ids used by this module (Avid CommandId enum). */
export const Cmd = {
	GetTrackList: 3,
	GetSessionName: 42,
	GetTransportState: 59,
	RegisterConnection: 70,
	SetTrackMuteState: 85,
	SetTrackSoloState: 86,
	SetTrackRecordEnableState: 88,
	SubscribeToEvents: 132,
	PollEvents: 135,
	UnsubscribeFromEvents: 136,
}

/** Event ids PTSL can push (Avid EventId enum). */
export const Evt = {
	SessionOpened: 'EId_SessionOpened',
	SessionCreated: 'EId_SessionCreated',
	SessionClosed: 'EId_SessionClosed',
	TrackSoloStateChanged: 'EId_TrackSoloStateChanged',
	TrackMuteStateChanged: 'EId_TrackMuteStateChanged',
}

const TASK_COMPLETED = 3

/** Track types that cannot be muted via PTSL, or that we never expose. */
const UNMUTABLE_TYPES = new Set([
	'TT_Master',
	'TT_Video',
	'TT_Tempo',
	'TT_Markers',
	'TT_Meter',
	'TT_KeySignature',
	'TT_ChordSymbols',
])

/**
 * Thin PTSL client.
 *
 * Emits: 'connected', 'disconnected' (Error|null), 'tracks' (Track[]),
 *        'muteChanged' ({ name, muted }), 'sessionChanged'
 */
export class PtslClient extends EventEmitter {
	constructor(log = () => {}) {
		super()
		this.log = log
		this.sessionId = ''
		this.client = null
		this.tracks = []
		this.connected = false
		this._eventStream = null
		this._pollTimer = null
		this._closing = false
	}

	async connect(host, port, companyName, applicationName) {
		this._closing = false
		const def = protoLoader.loadSync(path.join(__dirname, 'ptsl-min.proto'), {
			keepCase: true,
			longs: String,
			defaults: true,
		})
		const pkg = grpc.loadPackageDefinition(def)
		const target = `${host}:${port}`
		this.client = new pkg.ptsl.PTSL(target, grpc.credentials.createInsecure())

		await new Promise((resolve, reject) => {
			const deadline = Date.now() + 8000
			this.client.waitForReady(deadline, (err) => (err ? reject(err) : resolve()))
		})

		// RegisterConnection returns the session id used by every later request.
		const body = await this.command(Cmd.RegisterConnection, {
			company_name: companyName,
			application_name: applicationName,
		})
		this.sessionId = body?.session_id ?? ''
		this.connected = true
		this.log('debug', `PTSL registered, session_id=${this.sessionId}`)
		this.emit('connected')
		return this.sessionId
	}

	/** Run one command. Returns the parsed response body (or null when empty). */
	command(commandId, requestBody = {}) {
		return new Promise((resolve, reject) => {
			if (!this.client) return reject(new Error('not connected'))
			const req = {
				header: {
					task_id: '',
					command: commandId,
					version: PTSL_VERSION,
					session_id: this.sessionId,
				},
				request_body_json: JSON.stringify(requestBody),
			}
			this.client.SendGrpcRequest(req, (err, res) => {
				if (err) return reject(err)
				const status = res?.header?.status
				if (status !== undefined && status !== TASK_COMPLETED && res?.response_error_json) {
					let msg = res.response_error_json
					try {
						const parsed = JSON.parse(msg)
						msg = parsed?.errors?.[0]?.command_error_message ?? msg
					} catch {
						/* leave raw */
					}
					return reject(new Error(`PTSL command ${commandId} failed: ${msg}`))
				}
				if (!res?.response_body_json) return resolve(null)
				try {
					resolve(JSON.parse(res.response_body_json))
				} catch (e) {
					reject(new Error(`bad JSON in PTSL response: ${e.message}`))
				}
			})
		})
	}

	/** Fetch the session's mutable tracks (Master/Video/etc. filtered out). */
	async getTracks() {
		const body = await this.command(Cmd.GetTrackList, {
			page_limit: 4096,
			track_filter_list: [],
			is_filter_list_additive: false,
		})
		const raw = Array.isArray(body?.track_list) ? body.track_list : []
		this.tracks = raw
			.filter((t) => !UNMUTABLE_TYPES.has(t.type))
			.map((t) => ({
				name: t.name,
				id: t.id,
				index: t.index,
				type: t.type,
				muted: !!t.track_attributes?.is_muted,
				soloed: !!t.track_attributes?.is_soloed,
				hidden: t.track_attributes?.is_hidden !== 'None',
			}))
		this.emit('tracks', this.tracks)
		return this.tracks
	}

	async getSessionName() {
		const body = await this.command(Cmd.GetSessionName, {})
		return body?.session_name ?? ''
	}

	/** Set mute on one or many tracks, by name. */
	async setMute(trackNames, enabled) {
		const names = Array.isArray(trackNames) ? trackNames : [trackNames]
		if (names.length === 0) return
		await this.command(Cmd.SetTrackMuteState, { track_names: names, enabled: !!enabled })
		for (const n of names) {
			const t = this.tracks.find((x) => x.name === n)
			if (t) t.muted = !!enabled
			this.emit('muteChanged', { name: n, muted: !!enabled })
		}
	}

	async setSolo(trackNames, enabled) {
		const names = Array.isArray(trackNames) ? trackNames : [trackNames]
		if (names.length === 0) return
		await this.command(Cmd.SetTrackSoloState, { track_names: names, enabled: !!enabled })
		for (const n of names) {
			const t = this.tracks.find((x) => x.name === n)
			if (t) t.soloed = !!enabled
		}
	}

	/**
	 * Subscribe to PTSL push events (mute/solo/session changes) over the
	 * streaming RPC, so state changes made in Pro Tools reach us without polling.
	 * Resolves true if the stream was established.
	 */
	subscribeEvents(
		events = [Evt.TrackMuteStateChanged, Evt.TrackSoloStateChanged, Evt.SessionOpened, Evt.SessionClosed],
	) {
		return new Promise((resolve) => {
			if (!this.client) return resolve(false)
			const req = {
				header: {
					task_id: '',
					command: Cmd.SubscribeToEvents,
					version: PTSL_VERSION,
					session_id: this.sessionId,
				},
				request_body_json: JSON.stringify({ events }),
			}
			let settled = false
			try {
				const stream = this.client.SendGrpcStreamingRequest(req)
				this._eventStream = stream
				stream.on('data', (res) => {
					if (!settled) {
						settled = true
						resolve(true)
					}
					this._handleEventResponse(res)
				})
				stream.on('error', (err) => {
					this._eventStream = null
					if (!settled) {
						settled = true
						resolve(false)
					} else if (!this._closing) {
						this.log('debug', `PTSL event stream error: ${err.message}`)
						this.emit('streamEnded')
					}
				})
				stream.on('end', () => {
					this._eventStream = null
					if (!settled) {
						settled = true
						resolve(false)
					} else if (!this._closing) {
						this.emit('streamEnded')
					}
				})
				// If nothing arrives promptly, treat the subscription as established
				// anyway -- PTSL only sends on an actual change.
				setTimeout(() => {
					if (!settled) {
						settled = true
						resolve(true)
					}
				}, 1500)
			} catch (e) {
				this.log('debug', `subscribeEvents failed: ${e.message}`)
				resolve(false)
			}
		})
	}

	_handleEventResponse(res) {
		let body = null
		try {
			body = res?.response_body_json ? JSON.parse(res.response_body_json) : null
		} catch {
			return
		}
		const ev = body?.event ?? body
		if (!ev) return
		const id = ev.event_id ?? ev.eventId
		let data = ev.event_data_json ?? ev.eventDataJson ?? null
		if (typeof data === 'string') {
			try {
				data = JSON.parse(data)
			} catch {
				/* keep string */
			}
		}
		if (id === Evt.TrackMuteStateChanged || id === Evt.TrackSoloStateChanged) {
			this.emit('trackStateEvent', { id, data })
		} else if (id === Evt.SessionOpened || id === Evt.SessionClosed || id === Evt.SessionCreated) {
			this.emit('sessionChanged', id)
		}
	}

	close() {
		this._closing = true
		this.connected = false
		if (this._pollTimer) {
			clearInterval(this._pollTimer)
			this._pollTimer = null
		}
		if (this._eventStream) {
			try {
				this._eventStream.cancel()
			} catch {
				/* ignore */
			}
			this._eventStream = null
		}
		if (this.client) {
			try {
				this.client.close()
			} catch {
				/* ignore */
			}
			this.client = null
		}
	}
}
