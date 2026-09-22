/**
 * Integration smoke test for the impure host half (`index.js`).
 *
 * The unit tests in the package cover the pure rule table. This one drives the
 * real `apply()` against a fake Cordis context — real listener registration,
 * real event envelopes, real ordering — so the failure modes that only appear
 * once the pieces are wired together (listener argument order, the
 * track-before-await ordering, the memory read that must happen before the
 * memory write, the domain-less fallback) are caught before the plugin is ever
 * mounted in a live profile.
 *
 * `ctx.storageDomain` is deliberately absent here: this exercises the
 * process-local Map fallback end to end.
 *
 * Run: node _verify/apply.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../dsh-effort-memory/index.js'

const A = { provider: 'p', model: 'a' }
const B = { provider: 'p', model: 'b' }
const C = { provider: 'p', model: 'no-reasoning' }
const D = { provider: 'p', model: 'd' }

/** A capability table: route -> advertised effort ids (absent = no reasoning). */
function bench({ efforts }) {
  const calls = []
  const warnings = []
  const listeners = new Map()
  const fake = {
    llm: {
      async resolveModelInfo(provider, model) {
        const ids = efforts[JSON.stringify([provider, model])]
        return ids === undefined ? { provider, model } : { provider, model, reasoning: { efforts: ids.map((id) => ({ id, name: id })) } }
      },
    },
    sessionController: {
      async selectModel(request) {
        calls.push({ ...request })
        return { selected: { provider: request.provider, model: request.model } }
      },
    },
    logger: { warn: (text) => warnings.push(String(text)), info() {} },
    get(name) {
      return undefined
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  apply(fake)
  const session = { id: 'session-test', firstLiveSeq: 0 }
  let seq = 0
  const fire = async (selection) => {
    seq += 1
    const event = { type: 'model/selection', seq, time: Date.now(), data: selection }
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    // Let the fire-and-forget restore path settle: memory.ready, then the
    // model-info probe, then the re-issue.
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { calls, warnings, fire, registrations: listeners.get('session/event')?.length ?? 0 }
}

/** Warnings other than the expected, once-per-apply, domain-less fallback. */
const realWarnings = (b) => b.warnings.filter((text) => !/storageDomain is not mounted/.test(text))

test('apply registers exactly one listener and declares its hard dependencies', () => {
  const b = bench({ efforts: {} })
  assert.equal(b.registrations, 1)
  assert.deepEqual(inject, ['llm', 'sessionController'])
  assert.equal(name, 'effort-memory')
})

test('a first visit to a never-used model is left on its own default, then a return restores', async () => {
  const b = bench({
    efforts: {
      [JSON.stringify([A.provider, A.model])]: ['off', 'low', 'medium', 'high', 'max'],
      [JSON.stringify([B.provider, B.model])]: ['off', 'low', 'high'],
    },
  })

  // The user picks max on A (their own action, not a switch).
  await b.fire({ ...A, reasoningEffort: 'max' })
  assert.deepEqual(b.calls, [])

  // A -> B: B has never been used, so it keeps B's default. No re-issue.
  await b.fire({ ...B, reasoningEffort: 'low' })
  assert.deepEqual(b.calls, [], 'a first visit must not re-issue anything')

  // The user picks high on B: an effort-only change, never overridden.
  await b.fire({ ...B, reasoningEffort: 'high' })
  assert.deepEqual(b.calls, [], 'an effort-only change is the user\'s own choice')

  // B -> A: A's default is medium, the remembered level is max.
  await b.fire({ ...A, reasoningEffort: 'medium' })
  assert.deepEqual(b.calls, [{ sessionId: 'session-test', provider: 'p', model: 'a', reasoningEffort: 'max' }])

  // A's own re-issue lands: same route, effort now equals memory. It must be
  // terminal — no third event, no second call.
  await b.fire({ ...A, reasoningEffort: 'max' })
  assert.equal(b.calls.length, 1, 'the re-issue must not re-enter the rule')

  // B kept its own remembered level independently: back to B, whose default is
  // low, and B's memory (high) comes back rather than A's max.
  await b.fire({ ...B, reasoningEffort: 'low' })
  assert.deepEqual(b.calls[1], { sessionId: 'session-test', provider: 'p', model: 'b', reasoningEffort: 'high' })
})

test('a route whose capability is gone is skipped silently', async () => {
  const b = bench({
    efforts: {
      [JSON.stringify([A.provider, A.model])]: ['low', 'max'],
      // C advertises nothing at all.
    },
  })
  await b.fire({ ...A, reasoningEffort: 'max' })
  // A -> C: C declares no reasoning, so there is nothing to re-issue and
  // nothing to complain about.
  await b.fire({ ...C, reasoningEffort: 'low' })
  assert.deepEqual(b.calls, [], 'no capability, no re-issue, no error')
  assert.deepEqual(realWarnings(b), [], 'and nothing worth warning about')
  // C -> A is an ordinary switch back: A's memory still applies.
  await b.fire({ ...A, reasoningEffort: 'low' })
  assert.deepEqual(b.calls, [{ sessionId: 'session-test', provider: 'p', model: 'a', reasoningEffort: 'max' }])
  assert.deepEqual(realWarnings(b), [])
})

test('a remembered level the target no longer advertises falls back silently', async () => {
  const dKey = JSON.stringify([D.provider, D.model])
  const aKey = JSON.stringify([A.provider, A.model])
  const efforts = { [aKey]: ['low', 'max'], [dKey]: ['low', 'max'] }
  const b = bench({ efforts })

  // D is used once at max, so D's memory is max.
  await b.fire({ ...D, reasoningEffort: 'max' })
  await b.fire({ ...A, reasoningEffort: 'low' })

  // dsh-custom-reasoning-effort rewrites D's table without max.
  efforts[dKey] = ['low', 'high']

  // A -> D: D's default is low, memory says max, which D no longer advertises.
  await b.fire({ ...D, reasoningEffort: 'low' })
  assert.deepEqual(b.calls, [], 'a stale level must fall back to the default, with no retry')
  assert.deepEqual(realWarnings(b), [], 'and without a warning: this is expected, not a failure')
})

test('a switch whose incoming effort already equals memory does nothing', async () => {
  const b = bench({
    efforts: {
      [JSON.stringify([A.provider, A.model])]: ['low', 'max'],
      [JSON.stringify([B.provider, B.model])]: ['off', 'low', 'max'],
    },
  })
  // A is used at max; B's default is max as well (adapter default), so the
  // switch already carries the remembered level and needs no repair.
  await b.fire({ ...A, reasoningEffort: 'max' })
  await b.fire({ ...B, reasoningEffort: 'max' })
  await b.fire({ ...A, reasoningEffort: 'max' })
  assert.deepEqual(b.calls, [])
})

test('replay seeds below firstLiveSeq are ignored', async () => {
  const calls = []
  const listeners = new Map()
  const fake = {
    llm: { async resolveModelInfo(provider, model) { return { provider, model, reasoning: { efforts: [{ id: 'max', name: 'max' }] } } } },
    sessionController: { async selectModel(request) { calls.push(request); return {} } },
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on(event, listener) { listeners.set(event, listener); return () => {} },
    effect: (callback) => { const d = callback(); return typeof d === 'function' ? d : () => {} },
  }
  apply(fake)
  const session = { id: 's', firstLiveSeq: 10 }
  listeners.get('session/event')(session, { type: 'model/selection', seq: 9, time: 0, data: { ...A, reasoningEffort: 'max' } })
  listeners.get('session/event')(session, { type: 'model/selection', seq: 11, time: 0, data: { ...B, reasoningEffort: 'max' } })
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [], 'constructor seeds never act, and a baseline alone never acts')
})

test('a missing storage domain degrades to memory in this process, with one warning', async () => {
  const b = bench({ efforts: { [JSON.stringify([A.provider, A.model])]: ['low', 'max'], [JSON.stringify([B.provider, B.model])]: ['low'] } })
  await b.fire({ ...A, reasoningEffort: 'max' })
  await b.fire({ ...B, reasoningEffort: 'low' })
  await b.fire({ ...A, reasoningEffort: 'low' })
  assert.equal(b.calls.length, 1)
  assert.equal(b.warnings.length, 1)
  assert.match(b.warnings[0], /storageDomain is not mounted/)
})
