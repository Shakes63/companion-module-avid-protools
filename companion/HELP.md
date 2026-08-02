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

Mirrors console channel and DCA **ON** state onto Pro Tools track mutes, so the
recording/broadcast rig follows front of house automatically.

Yamaha **ON = unmuted**, so a channel switched **off** mutes the matching Pro
Tools track. The module connects to the console on TCP **49280** and reacts to
the console's own change notifications, so it responds immediately.

Mapping is one rule per line:

```
33=Vox 1
45=HH 1
dca8=Band
```

`33=` is input channel 33; `dca8=` is DCA 8. Names are matched against the live
session and tolerate stray whitespace and case differences.

It only acts when a console value **changes**, so muting from a Companion button
still works as an override until the desk next moves that channel. On connect
(and whenever the follow is re-enabled) it syncs Pro Tools to the console once.

## Limitations

- **No fader/volume control.** PTSL exposes no live volume command; the
  track-control commands that exist are timeline automation breakpoints and are
  reported as unsupported by current Pro Tools versions.
- Master and video tracks are not mutable via PTSL and are hidden from lists.
