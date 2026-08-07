# Backlog

Planned work, roughly in priority order.

## Finish verifying the `@companion-module/base` 2.x build on real hardware

Deployed to the Graham booth Mac (`gr-tech`, Companion **5.0.3**) on 2026-08-07
and running against the live rig. Migration applied, from the base 2.0.0
breaking-change list:

- `runEntrypoint(X, [])` → `export default X`
- `setVariableDefinitions` takes an **object** keyed by variable id, not an array
- `parseVariablesInString` removed from the class (Companion expands values first)
- `setPresetDefinitions(presets)` → `setPresetDefinitions(structure, presets)`,
  with presets typed `'simple'` and grouped by a section structure rather than
  a `category` string
- manifest gained `type: "connection"`

Confirmed live: connection reaches Ok (`session_name` populated), tracks
populate (61), variables update (`muted_count`, per-track `mute_*`/`solo_*`),
console follow connects and re-syncs (`cl5_connected`/`cl5_sync` = 1, 11
mappings), and `saveConfig()` from `init()` works — the existing 11-rule text
mapping was adopted into the structured rows on first load.

Still to check, since both need a button press or the config panel and the rig
was in use:

- Actions actually firing: mute, group mute, solo.
- Feedbacks lighting and presets appearing.
- How 16 rows × 3 fields render in the config panel — legibility only, the
  values are known good.

Deployment notes for next time live in the `remote-machines` skill: quit
Companion before copying, and note that a base-version change needs a full app
restart because Companion caches the module's resolved base path.

## Structured editor for the console mapping — done, live

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

The editor shows only the rows in use. Companion config has no button field, so
the row count is a `number` field whose arrows add and remove rows, and rows
above it are hidden with `isVisibleExpression`. That works in config panels —
bmd-atem 4.0.2 does the same thing to hide its Target IP behind a Bonjour pick —
but it is evaluated by the config panel in the browser, so **it has not been
seen rendering here**. Row 1 carries no expression on purpose: if the expression
ever fails, the panel still shows one usable row instead of nothing.

Still open:

- The track dropdown is a snapshot from when the config page opened; refreshing
  means saving and reopening the config. A real refresh button would need a
  custom config UI.
- Only `MIXER:Current` is addressed, so mappings follow whatever is loaded, not a
  specific scene.
- Dropping the text field also dropped paste-in-a-mapping and the >16 escape
  hatch. If either is missed, an import/export action would be a better home for
  it than the config panel.

## Re-check fader support on new Pro Tools releases

PTSL currently exposes no live volume control. `GetTrackControlInfo` (148) and
`Get`/`SetTrackControlBreakpoints` (149/150) exist in the command enum, but
148/149 return `PT_UnsupportedCommand` on Pro Tools 2025.6.1, and breakpoints
address timeline automation rather than live fader position in any case.

Worth re-testing after each Pro Tools release. If real volume control appears,
fader actions — including timed fades — become possible without falling back to
HUI, which is bank/position based rather than by-name.
