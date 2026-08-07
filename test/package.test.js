import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildConfig = createRequire(import.meta.url)(path.join(root, 'build-config.cjs'))

/** Every file under src/ that is read from disk at runtime via __dirname. */
function runtimeAssets() {
	const found = []
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
			} else if (entry.name.endsWith('.js')) {
				const source = fs.readFileSync(full, 'utf8')
				for (const m of source.matchAll(/__dirname,\s*['"]([^'"]+)['"]/g)) {
					found.push(path.relative(root, path.join(dir, m[1])))
				}
			}
		}
	}
	walk(path.join(root, 'src'))
	return found
}

// Bundling collapses src/ into one main.js at the package root, so anything the
// code opens at runtime stops being where it was and has to be shipped beside
// the bundle. Missing it fails only on first connect, which is far too late.
test('every runtime asset is shipped in the built package', () => {
	const assets = runtimeAssets()
	assert.ok(assets.length > 0, 'expected to find at least one __dirname asset read')

	const extraFiles = buildConfig.extraFiles ?? []
	for (const asset of assets) {
		assert.ok(fs.existsSync(path.join(root, asset)), `${asset} is referenced but missing from the repo`)
		assert.ok(extraFiles.includes(asset), `${asset} is read at runtime but not in build-config.cjs extraFiles`)
	}
})

// extraFiles copies by basename into the package root, so two assets with the
// same filename would silently overwrite each other.
test('shipped asset basenames do not collide', () => {
	const names = (buildConfig.extraFiles ?? []).map((f) => path.basename(f))
	assert.equal(new Set(names).size, names.length, `duplicate basenames in extraFiles: ${names.join(', ')}`)
})
