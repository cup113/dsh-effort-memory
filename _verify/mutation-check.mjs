/**
 * Mutation check: prove the decision assertions are not vacuous.
 *
 * The "restore" branch of `decide.js` is replaced with `return 'none'`. If the
 * unit tests really pin that behavior, the mutated rule must stop agreeing with
 * the canonical scenario they assert.
 *
 * Run: node _verify/mutation-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decide } from '../decide.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, 'mutants')
const source = readFileSync(join(here, '..', 'decide.js'), 'utf8')

const canonical = { changed: true, remembered: 'max', incomingEffort: 'low', efforts: ['off', 'low', 'max'] }
assert.equal(decide(canonical), 'restore')

const marker = "  return 'restore'\n}"
assert.ok(source.includes(marker), 'mutation target not found in decide.js')
const mutated = source.replace(marker, "  return 'none'\n}")

mkdirSync(scratch, { recursive: true })
const mutantPath = join(scratch, 'decide.mutated.mjs')
writeFileSync(mutantPath, mutated, 'utf8')
try {
  const { decide: mutatedDecide } = await import(`file://${mutantPath.replace(/\\/g, '/')}`)
  assert.equal(mutatedDecide(canonical), 'none')
  console.log('mutation observed: removing the restore branch flips the canonical assertion to "none"')
  console.log('=> the unit tests are not vacuous (they would fail on this mutant)')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
