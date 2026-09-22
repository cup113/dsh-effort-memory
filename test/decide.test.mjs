/**
 * dsh-effort-memory — pure-layer and packaging tests.
 *
 * These run with `node --test` (Node's native type stripping is not even
 * needed: everything here is plain ESM). They deliberately cover two different
 * things:
 *
 *   1. the decision rule table of `decide.js`, branch by branch — including the
 *      branches that must *not* act, which is where a regression would silently
 *      start overriding the user's own choices;
 *   2. the packaging parity the Loader depends on, because a mismatch there
 *      fails the whole profile at boot rather than this plugin alone.
 *
 * @module dsh-effort-memory/test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { decide, effortId, outgoing, routeKey, seedFromProjection } from '../decide.js'
import * as plugin from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('routeKey cannot collide across models that carry separators', () => {
  assert.equal(routeKey('a', 'b/c'), JSON.stringify(['a', 'b/c']))
  assert.notEqual(routeKey('a/b', 'c'), routeKey('a', 'b/c'))
  assert.notEqual(routeKey('a', 'b:c'), routeKey('a:b', 'c'))
  assert.equal(routeKey('a', 'b'), routeKey('a', 'b'))
})

test('effortId treats an absent or empty effort as no effort', () => {
  assert.equal(effortId({ reasoningEffort: 'max' }), 'max')
  assert.equal(effortId({ reasoningEffort: '' }), undefined)
  assert.equal(effortId({ reasoningEffort: 7 }), undefined)
  assert.equal(effortId({}), undefined)
  assert.equal(effortId(undefined), undefined)
  assert.equal(effortId(null), undefined)
})

test('outgoing remembers only a real previous route with a real effort', () => {
  assert.deepEqual(outgoing({ route: 'A', effort: 'max' }), { key: 'A', effort: 'max' })
  assert.equal(outgoing(undefined), undefined)
  assert.equal(outgoing({ route: 'A' }), undefined)
  assert.equal(outgoing({ route: 'A', effort: '' }), undefined)
})

test('decide never acts without a route change', () => {
  assert.equal(decide({ changed: false, remembered: 'max', incomingEffort: 'low', efforts: ['low', 'max'] }), 'none')
})

test('decide leaves a never-used model on its own default', () => {
  assert.equal(decide({ changed: true, remembered: undefined, incomingEffort: 'low', efforts: undefined }), 'none')
  assert.equal(decide({ changed: true, remembered: undefined, incomingEffort: 'low', efforts: ['low', 'max'] }), 'none')
})

test('decide treats an already-effective effort as nothing to do', () => {
  // This is the loop breaker: the event the re-issue itself produces carries
  // the remembered effort, so it must decide "none" without any further work.
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'max', efforts: undefined }), 'none')
})

test('decide probes capability exactly once, only when a restore may be needed', () => {
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'low', efforts: undefined }), 'probe')
})

test('decide falls back silently when the target declares no such level', () => {
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'low', efforts: [] }), 'none')
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'low', efforts: ['low', 'high'] }), 'none')
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'low', efforts: null }), 'none')
})

test('decide restores a remembered level the target still advertises', () => {
  assert.equal(decide({ changed: true, remembered: 'max', incomingEffort: 'low', efforts: ['off', 'low', 'max'] }), 'restore')
})

test('seedFromProjection prefers pending, falls back to lastUsed, rejects junk', () => {
  const pending = { provider: 'p', model: 'm', reasoningEffort: 'max' }
  const lastUsed = { provider: 'p', model: 'other', reasoningEffort: 'low' }
  assert.deepEqual(seedFromProjection({ lastUsed, pending }), { route: routeKey('p', 'm'), effort: 'max' })
  assert.deepEqual(seedFromProjection({ lastUsed, pending: null }), { route: routeKey('p', 'other'), effort: 'low' })
  assert.deepEqual(seedFromProjection({ lastUsed: { provider: 'p', model: 'm' }, pending: null }), {
    route: routeKey('p', 'm'),
    effort: undefined,
  })
  assert.equal(seedFromProjection({ lastUsed: null, pending: null }), undefined)
  assert.equal(seedFromProjection(undefined), undefined)
  assert.equal(seedFromProjection({ lastUsed: { provider: 'p' }, pending: null }), undefined)
  assert.equal(seedFromProjection({ lastUsed: { provider: '', model: 'm' }, pending: null }), undefined)
})

test('the host half exports the shape a bundle row mounts', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'effort-memory')
  assert.deepEqual(plugin.inject, ['llm', 'sessionController'])
  assert.equal(plugin.default, undefined)
})

test('the bundle patch, the package manifest, and the plugin agree', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  assert.equal(manifest.name, 'dsh-effort-memory')
  assert.equal(manifest.private, true)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.main, './index.js')
  assert.equal(manifest.exports['.'], './index.js')

  assert.match(patch, new RegExp(`id: ${plugin.name}\\b`))
  assert.match(patch, new RegExp(`name: ${manifest.name}\\b`))
  // One insert, one row: the Loader rejects a repeated entry id at boot.
  assert.equal(patch.match(/^\s*- insert:/gm)?.length, 1)
  assert.equal(patch.match(/^\s*- id:/gm)?.length, 1)
})

test('the storage domain name is legal for the storage backend', () => {
  const source = readFileSync(join(root, 'index.js'), 'utf8')
  const declared = /const DOMAIN = \{\s*name: '([^']+)'/.exec(source)?.[1]
  assert.equal(declared, 'effort_memory')
  // UNIT_NAME_RE in @deepseek-ai/dsh-storage forbids the hyphen the package,
  // row id, and plugin name all use.
  assert.match(declared, /^[a-z][a-z0-9_]*$/)
})
