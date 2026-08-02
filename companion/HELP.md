# Avid Pro Tools (PTSL)

Controls Pro Tools through Avid's **Pro Tools Scripting SDK (PTSL)**. Tracks are
addressed **by name**, so a button keeps working no matter how many tracks the
session has or how they are reordered.

State is driven by Pro Tools **push events**, so mute/solo feedback updates in
real time rather than on a poll.

## Requirements

- Pro Tools **2023.3 or newer** (this module is developed against 2025.6.1).
- Scripting must be enabled in Pro Tools.
- Pro Tools must be **running with a session open** — PTSL only answers then.

## Connecting

Pro Tools binds its scripting server to **127.0.0.1:31416 only**. That is fine
when Companion runs on the same machine, but if Companion is on another computer
the port must be exposed on the network by a small relay on the Pro Tools
machine (for example `socat`, an SSH tunnel, or any TCP forwarder from a LAN
port to `127.0.0.1:31416`).

| Setting         | Same machine as Pro Tools | Companion on another machine  |
| --------------- | ------------------------- | ----------------------------- |
| **Host**        | `127.0.0.1`               | IP of the Pro Tools computer  |
| **Target Port** | `31416`                   | the relay's port (e.g. 31417) |

**Client Name** is what Pro Tools shows for this connection. **State refresh** is
only a backstop — push events keep things live, so it can stay high.

## Actions

| Action                            | Notes                                                     |
| --------------------------------- | --------------------------------------------------------- |
| Track: mute / unmute / toggle     | Pick a track from the live session list, or type a name.  |
| Tracks: mute a group (scene)      | Acts on several tracks at once. Toggle is all-or-nothing. |
| Track: solo / unsolo / toggle     |                                                           |
| Refresh track list                | Re-reads the session.                                     |
| CL5 follow: enable/disable/toggle | See below. Re-enabling re-syncs immediately.              |
| CL5 follow: re-sync now           | Force Pro Tools to match the console.                     |

## Feedbacks

- **Track is muted** / **Track is soloed**
- **Group is muted** — true when every selected track is muted (pairs with the
  group action)
- **CL5 follow is enabled** / **CL5 console is connected**

## Variables

`session_name`, `track_count`, `muted_count`, plus `mute_<track>` and
`solo_<track>` (1/0) for every track. Console follow adds `cl5_sync`,
`cl5_connected` and `cl5_mapped`.

## Presets

A ready-made mute button for every track in the session, with muted feedback
already attached.

## Yamaha CL/QL console follow (optional)

Mirrors the console onto Pro Tools track mutes, so the recording/broadcast rig
follows front of house automatically. The module connects to the console on TCP
**49280** and reacts to the console's own change notifications, so it responds
immediately.

A fader's **ON = unmuted**, so a channel, mix, matrix or DCA switched **off**
mutes the matching Pro Tools track. A **mute group runs the other way**: the
track is muted while the group is engaged, matching what the group does to the
console's own channels.

### Mapping

The connection config has a block of mapping rows: pick a **source**, its
**number**, and the **Pro Tools track** it drives. Leave a row on _unused_ to
skip it.

| Source        | Numbers on a CL/QL | In text  | Mutes the track when |
| ------------- | ------------------ | -------- | -------------------- |
| Input channel | 1–72               | `33=`    | switched off         |
| Mix bus       | 1–24               | `mix3=`  | switched off         |
| Matrix        | 1–8                | `mtx2=`  | switched off         |
| DCA           | 1–16               | `dca8=`  | switched off         |
| Mute group    | 1–8                | `mute2=` | **engaged**          |

A number outside the console's range is logged as a warning and ignored by the
desk. Smaller consoles in the family have fewer of each — a QL1 has 32 input
channels, not 72.

The track dropdown is filled from the live session, taken as a snapshot when the
config page opened — save and reopen the config to pick up session changes. A
track that is not in the list (not created yet, or a different session) can be
typed in instead.

Underneath the rows, the same mapping is kept as plain text, one rule per line,
for import/export:

```
33=Vox 1
45=HH 1
mix3=Aux Feed
mtx2=Lobby
dca8=Band
mute2=Choir
```

A bare number is an input channel; `ch33=` and `in33=` mean the same thing,
`matrix2=` is accepted for `mtx2=`, and `mutegroup2=` or `mg2=` for `mute2=`. Editing that text directly works too — the
rows are rebuilt from it when the config is saved, so it wins over the rows if
both are changed at once. Mappings beyond the 16 editor rows stay in the text
field and still run; the rows are left alone until the list is trimmed.

Names are matched against the live session and tolerate stray whitespace and
case differences.

It only acts when a console value **changes**, so muting from a Companion button
still works as an override until the desk next moves that channel. On connect
(and whenever the follow is re-enabled) it syncs Pro Tools to the console once.

## Limitations

- **No fader/volume control.** PTSL exposes no live volume command; the
  track-control commands that exist are timeline automation breakpoints and are
  reported as unsupported by current Pro Tools versions.
- Master and video tracks are not mutable via PTSL and are hidden from lists.
