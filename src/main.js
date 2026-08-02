import { InstanceBase, InstanceStatus, Regex } from '@companion-module/base'
import { PtslClient } from './ptsl/client.js'
import { Cl5Follow } from './cl5.js'
import {
	MAX_MAP_ROWS,
	mapRowFields,
	mappingWarnings,
	mappingsFromRows,
	parseMappings,
	rowsFromMappings,
	serializeMappings,
} from './mapping.js'
import { varSafe, trackChoices } from './util.js'

const CL5_POLL_DEFAULT = 5000
const CL5_MAP_EXAMPLE = ['33=Vox 1', '45=Pastor Mic', 'mix3=Aux Feed', 'mtx2=Lobby', 'dca8=Band', 'mute2=Choir'].join(
	'\n',
)

class ProToolsInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.ptsl = null
		this.tracks = []
		this.reconnectTimer = null
		this.pollTimer = null
		this.usingEvents = false
		this.cl5 = null
		this.mappings = []
	}

	async init(config) {
		this.config = config
		this.mappings = this.syncMappingConfig()
		this.updateStatus(InstanceStatus.Connecting)
		this.initDefinitions()
		await this.connect()
	}

	async destroy() {
		this.stopTimers()
		if (this.cl5) {
			this.cl5.stop()
			this.cl5 = null
		}
		if (this.ptsl) {
			this.ptsl.close()
			this.ptsl = null
		}
	}

	async configUpdated(config) {
		this.config = config
		this.mappings = this.syncMappingConfig()
		this.stopTimers()
		if (this.cl5) {
			this.cl5.stop()
			this.cl5 = null
		}
		if (this.ptsl) {
			this.ptsl.close()
			this.ptsl = null
		}
		this.updateStatus(InstanceStatus.Connecting)
		await this.connect()
	}

	/** Resolve a mapping's track name against the live session (tolerates
	 *  stray whitespace/case, e.g. a track literally named "Vocals "). */
	resolveTrack(name) {
		const want = String(name).trim().toLowerCase()
		const t = this.tracks.find((x) => x.name === name) || this.tracks.find((x) => x.name.trim().toLowerCase() === want)
		return t?.name ?? null
	}

	/**
	 * Reconcile the structured mapping rows with the free-text field and return
	 * the mappings to run with.
	 *
	 * Whichever side the user last touched wins. `cl5MapAuto` holds the text this
	 * module last generated, so text that no longer matches it was hand-edited
	 * (or imported) and gets adopted into the rows; otherwise the rows are the
	 * editor and are serialised back out to text.
	 */
	syncMappingConfig() {
		const cfg = this.config ?? {}
		const text = String(cfg.cl5Map ?? '')
		const rowsOwnText = typeof cfg.cl5MapAuto === 'string' && text === cfg.cl5MapAuto

		let mappings
		let patch = null

		if (rowsOwnText) {
			mappings = mappingsFromRows(cfg)
			const out = serializeMappings(mappings)
			if (out !== text) patch = { cl5Map: out, cl5MapAuto: out }
		} else {
			mappings = parseMappings(text)
			if (mappings.length <= MAX_MAP_ROWS) {
				// Adopt the text into the rows, leaving the text itself verbatim so
				// comments and formatting survive until the rows are next edited.
				patch = { ...rowsFromMappings(mappings), cl5MapAuto: text }
			} else {
				this.log(
					'warn',
					`Console mapping has ${mappings.length} rules, more than the ${MAX_MAP_ROWS} editor rows - the text field stays the source. Trim it to ${MAX_MAP_ROWS} rules to edit it as rows.`,
				)
			}
		}

		if (patch && Object.keys(patch).some((k) => cfg[k] !== patch[k])) {
			Object.assign(cfg, patch)
			this.config = cfg
			this.saveConfig(cfg)
		}
		for (const w of mappingWarnings(mappings)) this.log('warn', w)
		return mappings
	}

	startCl5() {
		if (this.cl5) {
			this.cl5.stop()
			this.cl5 = null
		}
		const mappings = this.mappings ?? []
		this.cl5 = new Cl5Follow((lvl, msg) => this.log(lvl, msg))

		this.cl5.on('connectionChanged', (up) => {
			this.setVariableValues({ cl5_connected: up ? 1 : 0 })
			this.checkFeedbacks('cl5Connected')
		})
		this.cl5.on('enabledChanged', (on) => {
			this.setVariableValues({ cl5_sync: on ? 1 : 0 })
			this.checkFeedbacks('cl5SyncActive')
		})
		this.cl5.on('consoleState', async ({ track, muted, label }) => {
			if (!this.cl5?.enabled) return
			const real = this.resolveTrack(track)
			if (!real) {
				this.log('warn', `CL5 ${label}: no Pro Tools track named "${track}"`)
				return
			}
			const cur = this.tracks.find((t) => t.name === real)?.muted
			if (cur === muted) return // already matches; don't spam Pro Tools
			this.log('info', `CL5 ${label} -> ${real} ${muted ? 'MUTE' : 'UNMUTE'}`)
			await this.doMute([real], muted)
		})

		this.cl5.start({
			host: String(this.config?.cl5Host ?? '').trim(),
			mappings,
			pollMs: Number(this.config?.cl5Poll) || CL5_POLL_DEFAULT,
			enabled: this.config?.cl5Enabled !== false,
		})
		this.setVariableValues({
			cl5_sync: this.config?.cl5Enabled !== false ? 1 : 0,
			cl5_connected: 0,
			cl5_mapped: mappings.length,
		})
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Pro Tools Scripting (PTSL)',
				value:
					'Pro Tools only listens on 127.0.0.1, so when Companion runs on a different machine a small relay on the Pro Tools computer must expose the port on the network. Point Target Port at the relay (default 31417); use 31416 when Companion runs on the Pro Tools machine itself.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Pro Tools Host',
				width: 8,
				default: '127.0.0.1',
				regex: Regex.HOSTNAME,
				required: true,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port',
				width: 4,
				default: '31417',
				regex: Regex.PORT,
				required: true,
			},
			{
				type: 'textinput',
				id: 'appName',
				label: 'Client Name (shown to Pro Tools)',
				width: 6,
				default: 'Companion',
			},
			{
				type: 'number',
				id: 'pollInterval',
				label: 'State refresh (seconds)',
				tooltip: 'Backstop refresh. Push events keep state live, so this can stay high.',
				width: 6,
				default: 10,
				min: 1,
				max: 300,
			},
			{
				type: 'static-text',
				id: 'cl5info',
				width: 12,
				label: 'Follow a Yamaha CL/QL console',
				value:
					'Mirrors the console onto Pro Tools track mutes. A fader ON = unmuted, so an OFF channel, mix, matrix or DCA mutes the track; a mute group is the other way round and mutes the track when the group is engaged. Only acts when the console changes, so muting from a Companion button still works as an override until the desk next moves.',
			},
			{ type: 'checkbox', id: 'cl5Enabled', label: 'Enable console follow', width: 4, default: false },
			{
				type: 'textinput',
				id: 'cl5Host',
				label: 'Console IP',
				width: 4,
				default: '',
				regex: Regex.HOSTNAME,
			},
			{
				type: 'number',
				id: 'cl5Poll',
				label: 'Console re-poll (ms)',
				tooltip:
					'Backstop only. The console pushes changes instantly (NOTIFY), so this just re-syncs after a dropout. Low values add needless console traffic.',
				width: 4,
				default: 5000,
				min: 250,
				max: 60000,
			},
			{
				type: 'static-text',
				id: 'cl5mapinfo',
				width: 12,
				label: 'Mapping',
				value:
					'One console source per row; leave a row on "unused" to skip it. The track list is a snapshot taken when this page opened - save and reopen to pick up session changes, or type a name that is not in the list. The text field at the bottom holds the same mapping in plain text for import/export.',
			},
			...mapRowFields(this.configTrackChoices()),
			{
				type: 'textinput',
				id: 'cl5Map',
				label: 'Mapping as text (one rule per line)',
				tooltip: `Kept in sync with the rows above. Edit it directly to paste a mapping in - the rows are rebuilt from it on save. Example:\n${CL5_MAP_EXAMPLE}`,
				width: 12,
				default: '',
			},
		]
	}

	/** Track choices for the config dropdowns: the live session list, plus any
	 *  already-mapped track that is not currently in the session. */
	configTrackChoices() {
		const choices = this.tracks.map((t) => ({ id: t.name, label: t.name }))
		const known = new Set(choices.map((c) => c.id))
		for (const m of mappingsFromRows(this.config ?? {})) {
			if (known.has(m.track)) continue
			known.add(m.track)
			choices.push({ id: m.track, label: `${m.track} (not in session)` })
		}
		return choices
	}

	stopTimers() {
		for (const t of ['reconnectTimer', 'pollTimer']) {
			if (this[t]) {
				clearTimeout(this[t])
				clearInterval(this[t])
				this[t] = null
			}
		}
	}

	scheduleReconnect() {
		if (this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect().catch(() => {})
		}, 5000)
	}

	async connect() {
		const host = this.config?.host || '127.0.0.1'
		const port = parseInt(this.config?.port ?? '31417', 10)
		const appName = this.config?.appName || 'Companion'

		this.ptsl = new PtslClient((lvl, msg) => this.log(lvl, msg))
		this.ptsl.on('streamEnded', () => {
			// Push channel dropped -- fall back to polling until reconnect.
			this.usingEvents = false
		})
		this.ptsl.on('trackStateEvent', () => {
			this.refreshTracks().catch(() => {})
		})
		this.ptsl.on('sessionChanged', () => {
			this.refreshTracks().catch(() => {})
		})

		try {
			await this.ptsl.connect(host, port, 'Bitfocus', appName)
			this.updateStatus(InstanceStatus.Ok)
			await this.refreshTracks()

			this.usingEvents = await this.ptsl.subscribeEvents()
			this.log(
				'info',
				this.usingEvents ? 'Subscribed to Pro Tools push events' : 'Push events unavailable; polling instead',
			)

			const secs = Math.max(1, Number(this.config?.pollInterval ?? 10))
			this.pollTimer = setInterval(() => {
				this.refreshTracks().catch(() => {})
			}, secs * 1000)

			// Console follow starts only once the track list is known, so mappings
			// can be resolved to real track names straight away.
			this.startCl5()
		} catch (e) {
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			this.log('error', `Could not reach Pro Tools at ${host}:${port} - ${e.message}`)
			if (this.ptsl) {
				this.ptsl.close()
				this.ptsl = null
			}
			this.scheduleReconnect()
		}
	}

	/** Pull the track list and push names/state into definitions + variables. */
	async refreshTracks() {
		if (!this.ptsl?.connected) return
		let tracks
		try {
			tracks = await this.ptsl.getTracks()
		} catch (e) {
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
			if (this.ptsl) {
				this.ptsl.close()
				this.ptsl = null
			}
			this.scheduleReconnect()
			return
		}

		const namesChanged = tracks.length !== this.tracks.length || tracks.some((t, i) => t.name !== this.tracks[i]?.name)
		this.tracks = tracks
		this.updateStatus(InstanceStatus.Ok)

		if (namesChanged) {
			// Track set changed -> rebuild dropdowns, variables and presets.
			this.initDefinitions()
		}
		this.updateVariableValues()
		this.checkFeedbacks('trackMuted', 'trackSoloed', 'anyMuted')
	}

	initDefinitions() {
		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariableDefs())
		const { structure, presets } = this.buildPresets()
		this.setPresetDefinitions(structure, presets)
	}

	buildVariableDefs() {
		const defs = {
			session_name: { name: 'Session name' },
			track_count: { name: 'Track count' },
			muted_count: { name: 'Number of muted tracks' },
			cl5_sync: { name: 'CL5 follow enabled (1/0)' },
			cl5_connected: { name: 'CL5 console connected (1/0)' },
			cl5_mapped: { name: 'CL5 mapped channel count' },
		}
		for (const t of this.tracks) {
			const v = varSafe(t.name)
			if (!v) continue
			defs[`mute_${v}`] = { name: `${t.name} - muted (1/0)` }
			defs[`solo_${v}`] = { name: `${t.name} - soloed (1/0)` }
		}
		return defs
	}

	async updateVariableValues() {
		const values = {
			track_count: this.tracks.length,
			muted_count: this.tracks.filter((t) => t.muted).length,
		}
		for (const t of this.tracks) {
			const v = varSafe(t.name)
			if (!v) continue
			values[`mute_${v}`] = t.muted ? 1 : 0
			values[`solo_${v}`] = t.soloed ? 1 : 0
		}
		this.setVariableValues(values)

		if (this.ptsl?.connected) {
			try {
				this.setVariableValues({ session_name: await this.ptsl.getSessionName() })
			} catch {
				/* non-fatal */
			}
		}
	}

	buildActions() {
		const choices = trackChoices(this.tracks)
		const first = choices[0]?.id ?? ''

		// `allowCustom` dropdowns deliver a typed value in the same option.
		// Companion expands any variables before the callback runs.
		const resolve = (opt) => {
			const raw = String(opt.track ?? '').trim()
			return raw ? [raw] : []
		}

		return {
			mute: {
				name: 'Track: mute / unmute / toggle',
				options: [
					{ type: 'dropdown', id: 'track', label: 'Track', choices, default: first, allowCustom: true },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'Mute' },
							{ id: 'off', label: 'Unmute' },
						],
					},
				],
				callback: async ({ options }) => {
					const names = resolve(options)
					if (!names.length) return
					const cur = this.tracks.find((t) => t.name === names[0])?.muted ?? false
					const target = options.mode === 'toggle' ? !cur : options.mode === 'on'
					await this.doMute(names, target)
				},
			},

			muteMultiple: {
				name: 'Tracks: mute / unmute / toggle a group (scene)',
				description: 'Acts on several tracks at once. Toggle mutes them all unless they are already all muted.',
				options: [
					{
						type: 'multidropdown',
						id: 'tracks',
						label: 'Tracks',
						choices,
						default: [],
						minSelection: 0,
					},
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle (all-or-nothing)' },
							{ id: 'on', label: 'Mute all' },
							{ id: 'off', label: 'Unmute all' },
						],
					},
				],
				callback: async ({ options }) => {
					const names = (options.tracks ?? []).filter(Boolean)
					if (!names.length) return
					let target
					if (options.mode === 'toggle') {
						const present = this.tracks.filter((t) => names.includes(t.name))
						target = !(present.length > 0 && present.every((t) => t.muted))
					} else {
						target = options.mode === 'on'
					}
					await this.doMute(names, target)
				},
			},

			solo: {
				name: 'Track: solo / unsolo / toggle',
				options: [
					{ type: 'dropdown', id: 'track', label: 'Track', choices, default: first, allowCustom: true },
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'Solo' },
							{ id: 'off', label: 'Unsolo' },
						],
					},
				],
				callback: async ({ options }) => {
					const names = resolve(options)
					if (!names.length) return
					const cur = this.tracks.find((t) => t.name === names[0])?.soloed ?? false
					const target = options.mode === 'toggle' ? !cur : options.mode === 'on'
					try {
						await this.ptsl.setSolo(names, target)
						await this.refreshTracks()
					} catch (e) {
						this.log('error', `Solo failed: ${e.message}`)
					}
				},
			},

			refresh: {
				name: 'Refresh track list from Pro Tools',
				options: [],
				callback: async () => {
					await this.refreshTracks()
				},
			},

			cl5Sync: {
				name: 'CL5 follow: enable / disable / toggle',
				description: 'Turning it back on immediately re-syncs Pro Tools to the console.',
				options: [
					{
						type: 'dropdown',
						id: 'mode',
						label: 'Action',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'on', label: 'Enable' },
							{ id: 'off', label: 'Disable' },
						],
					},
				],
				callback: ({ options }) => {
					if (!this.cl5) return
					const target = options.mode === 'toggle' ? !this.cl5.enabled : options.mode === 'on'
					this.cl5.setEnabled(target)
					this.log('info', `CL5 follow ${target ? 'enabled' : 'disabled'}`)
				},
			},

			cl5Resync: {
				name: 'CL5 follow: re-sync now',
				options: [],
				callback: () => this.cl5?.resync(),
			},
		}
	}

	async doMute(names, target) {
		if (!this.ptsl?.connected) {
			this.log('warn', 'Not connected to Pro Tools')
			return
		}
		try {
			await this.ptsl.setMute(names, target)
			this.updateVariableValues()
			this.checkFeedbacks('trackMuted', 'anyMuted')
			// Confirm against Pro Tools rather than trusting our optimistic state.
			await this.refreshTracks()
		} catch (e) {
			this.log('error', `Mute failed: ${e.message}`)
		}
	}

	buildFeedbacks() {
		const choices = trackChoices(this.tracks)
		const first = choices[0]?.id ?? ''
		return {
			trackMuted: {
				type: 'boolean',
				name: 'Track is muted',
				defaultStyle: { bgcolor: 0x990000, color: 0xffffff },
				options: [{ type: 'dropdown', id: 'track', label: 'Track', choices, default: first, allowCustom: true }],
				callback: ({ options }) => !!this.tracks.find((t) => t.name === options.track)?.muted,
			},
			trackSoloed: {
				type: 'boolean',
				name: 'Track is soloed',
				defaultStyle: { bgcolor: 0xbb8800, color: 0x000000 },
				options: [{ type: 'dropdown', id: 'track', label: 'Track', choices, default: first, allowCustom: true }],
				callback: ({ options }) => !!this.tracks.find((t) => t.name === options.track)?.soloed,
			},
			anyMuted: {
				type: 'boolean',
				name: 'Group is muted (all selected tracks muted)',
				defaultStyle: { bgcolor: 0x990000, color: 0xffffff },
				options: [{ type: 'multidropdown', id: 'tracks', label: 'Tracks', choices, default: [] }],
				callback: ({ options }) => {
					const names = options.tracks ?? []
					const present = this.tracks.filter((t) => names.includes(t.name))
					return present.length > 0 && present.every((t) => t.muted)
				},
			},
			cl5SyncActive: {
				type: 'boolean',
				name: 'CL5 follow is enabled',
				defaultStyle: { bgcolor: 0x006600, color: 0xffffff },
				options: [],
				callback: () => !!this.cl5?.enabled,
			},
			cl5Connected: {
				type: 'boolean',
				name: 'CL5 console is connected',
				defaultStyle: { bgcolor: 0x006600, color: 0xffffff },
				options: [],
				callback: () => !!this.cl5?.connected,
			},
		}
	}

	buildPresets() {
		const presets = {}
		const ids = []
		for (const t of this.tracks) {
			const key = `mute_${varSafe(t.name)}`
			if (!key || presets[key]) continue
			ids.push(key)
			presets[key] = {
				type: 'simple',
				name: `Mute ${t.name}`,
				style: { text: t.name, size: '14', color: 0xffffff, bgcolor: 0x333333 },
				steps: [{ down: [{ actionId: 'mute', options: { track: t.name, mode: 'toggle' } }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'trackMuted',
						options: { track: t.name },
						style: { bgcolor: 0x990000, color: 0xffffff },
					},
				],
			}
		}
		const structure = [{ id: 'track_mutes', name: 'Track mutes', definitions: ids }]
		return { structure, presets }
	}
}

export default ProToolsInstance
