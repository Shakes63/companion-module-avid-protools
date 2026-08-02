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

## Structured editor for the console mapping

Today the console→track mapping is a single free-text field, one rule per line
(`33=Vox 1`, `dca8=Band`). It works but is typo-prone, offers no validation, and
requires knowing the exact Pro Tools track name.

Wanted: one mapping per row, built from dropdowns — source type (input channel /
DCA, later mix, matrix, mute group), number, and a Pro Tools track chosen from
the live session list (the module already builds that list for the mute
actions).

Constraints worth knowing before starting:

- Companion config fields have no repeating-row control, so this means either N
  fixed rows (blank = unused) or a custom config UI. N fixed rows keeps it all
  inside `getConfigFields()`.
- Config dropdown choices are fixed when the fields are defined, so the track
  list is a snapshot — needs a refresh affordance, and a free-text escape hatch
  for tracks not currently in the session.
- The existing text field should keep working underneath, so mappings still
  import/export as plain text.
- Track names can carry stray whitespace, so name resolution must stay tolerant.

## Status indicator for the PTSL relay

When Companion runs on a different machine from Pro Tools, a TCP relay is
required (Pro Tools binds its scripting port to loopback only). A relay is
typically a headless background process, so there is nothing to look at to
confirm it is alive — the Companion connection status is the only signal.

A small tray/menubar helper showing listen address, connection count and last
client would make that visible. It should supervise or wrap the relay rather
than replace it, so the relay still works headlessly.

## Re-check fader support on new Pro Tools releases

PTSL currently exposes no live volume control. `GetTrackControlInfo` (148) and
`Get`/`SetTrackControlBreakpoints` (149/150) exist in the command enum, but
148/149 return `PT_UnsupportedCommand` on Pro Tools 2025.6.1, and breakpoints
address timeline automation rather than live fader position in any case.

Worth re-testing after each Pro Tools release. If real volume control appears,
fader actions — including timed fades — become possible without falling back to
HUI, which is bank/position based rather than by-name.
