/**
 * Extra build configuration for `companion-module-build`.
 *
 * The PTSL client loads its protobuf definition from disk at runtime
 * (`path.join(__dirname, 'ptsl-min.proto')`), which the bundler cannot inline.
 * Running from source that resolves next to `src/ptsl/client.js`; in a built
 * package everything collapses into a single `main.js` at the package root, so
 * the .proto has to be shipped alongside it or the module fails on first
 * connect with ENOENT.
 *
 * `extraFiles` copies each match to the package root by basename, which is
 * where the bundle's `__dirname` points.
 */
module.exports = {
	extraFiles: ['src/ptsl/ptsl-min.proto'],
}
