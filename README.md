# companion-module-avid-protools

A [Bitfocus Companion](https://bitfocus.io/companion) module for **Avid Pro
Tools**, using Avid's official **Pro Tools Scripting SDK (PTSL)** over gRPC.

Tracks are addressed **by name**, so a button keeps working regardless of how
many tracks a session has or how they are ordered — and state is driven by Pro
Tools **push events**, so feedback is live rather than polled.

- Mute / unmute / toggle any track by name
- Mute a **group of tracks** as one scene (all-or-nothing toggle)
- Solo, and record-safe-friendly track state
- Feedbacks for muted / soloed / group-muted, and variables for every track
- A ready-made mute preset per track
- Optional **Yamaha CL/QL console follow** — mirrors console input channel, mix,
  matrix, DCA and mute group state onto Pro Tools mutes, mapped from dropdowns
  in the connection config

See [companion/HELP.md](companion/HELP.md) for setup and full documentation.

## Requirements

- Pro Tools 2023.3 or newer, with scripting enabled and a session open
- Companion 4.x / 5.x

> **Note:** Pro Tools binds its scripting server to `127.0.0.1:31416` only. If
> Companion runs on a different machine, a small TCP relay on the Pro Tools
> computer is required to expose that port on the network. See HELP.md.

## Known limitation: no fader control

PTSL provides **no live volume/fader control**. The only volume-related commands
(`GetTrackControlInfo`, `Get`/`SetTrackControlBreakpoints`) address _timeline
automation breakpoints_ rather than live fader position, and are reported as
`PT_UnsupportedCommand` by Pro Tools 2025.6.1. Mute is the practical equivalent.

## Development

```sh
yarn install
yarn test
yarn package
```

`yarn package` bundles `src/` into a single `main.js` at the package root, so
anything read from disk at runtime must also be listed in
[build-config.cjs](build-config.cjs) — currently the PTSL `.proto`, which
`extraFiles` copies next to the bundle. A missing asset there only fails on
first connect, so `test/package.test.js` checks the two stay in sync.

To run it from source, point Companion at the parent folder using
**developer mode** (Companion's launcher: enable developer mode and set the
developer modules path), then add an `avid-protools` connection.

## Protocol notes

PTSL exposes only two gRPC methods (`SendGrpcRequest` and
`SendGrpcStreamingRequest`) and carries every command payload as a JSON string.
This module therefore ships a minimal, wire-compatible protobuf definition of
just the request/response envelope
([src/ptsl/ptsl-min.proto](src/ptsl/ptsl-min.proto)) rather than redistributing
Avid's schema. Enum fields are encoded as `int32`, which is wire-compatible.

## License

MIT — see [LICENSE](LICENSE).
