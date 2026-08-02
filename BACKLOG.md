# Backlog

Planned work, roughly in priority order.

## Verify the `@companion-module/base` 2.x build against real hardware

The module was migrated from base `1.13` to `2.1.2` and has been validated only
as far as installing, importing and packaging cleanly. It has **not yet been
exercised against a live Pro Tools system** on the new base version.

Migration applied, from the base 2.0.0 breaking-change list:

- `runEntrypoint(X, [])` → `export default X`
- `setVariableDefinitions` takes an **object** keyed by variable id, not an array
- `parseVariablesInString` removed from the class (Companion expands values first)
- `setPresetDefinitions(presets)` → `setPresetDefinitions(structure, presets)`,
  with presets typed `'simple'` and grouped by a section structure rather than
  a `category` string
- manifest gained `type: "connection"`

To verify: connection reaches Ok, tracks populate, mute/group/solo actions fire,
feedbacks light, presets appear, and console follow connects and re-syncs.

Also unverified against a running Companion: the structured mapping editor
below. Its logic is covered by `test/mapping.test.js`, but nothing has confirmed
how 16 rows × 3 fields actually render in the config panel, or that
`saveConfig()` from `init()`/`configUpdated()` behaves as expected there.

## Structured editor for the console mapping — done, needs a live check

The console→track mapping is now 16 rows of dropdowns (source type, number,
Pro Tools track) in `src/mapping.js`, reconciled with the original free-text
field by `syncMappingConfig()` in `src/main.js`.

How the two sides stay in sync: `cl5MapAuto` stores the text the module last
generated. If the saved text still matches it, the rows are the editor and are
serialised back out to text; if it does not, the text was hand-edited or pasted
in and is adopted into the rows instead (verbatim, so comments survive one more
save). More than 16 rules keeps the text authoritative and leaves the rows
alone, so a large mapping is never silently truncated.

Source types are input channel, mix bus, matrix, DCA and mute group. The RCP
parameters were taken from the CL/QL parameter list, and `test/cl5.test.js`
covers what is polled and how replies are read, but only input channels and DCAs
have ever been exercised against a real desk. Mute groups are the ones to watch:
`MuteMaster/On` is the inverse of `Fader/On` (1 = the group is muting), which is
right per the QL5 manual but has never been seen on the wire here.

Still open:

- The track dropdown is a snapshot from when the config page opened; refreshing
  means saving and reopening the config. A real refresh button would need a
  custom config UI.
- Only `MIXER:Current` is addressed, so mappings follow whatever is loaded, not a
  specific scene.

## Re-check fader support on new Pro Tools releases

PTSL currently exposes no live volume control. `GetTrackControlInfo` (148) and
`Get`/`SetTrackControlBreakpoints` (149/150) exist in the command enum, but
148/149 return `PT_UnsupportedCommand` on Pro Tools 2025.6.1, and breakpoints
address timeline automation rather than live fader position in any case.

Worth re-testing after each Pro Tools release. If real volume control appears,
fader actions — including timed fades — become possible without falling back to
HUI, which is bank/position based rather than by-name.
