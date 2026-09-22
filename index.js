/**
 * dsh-effort-memory — host half.
 *
 * WHY this plugin exists: the composer's model seat renders the effort it reads
 * from the durable `modelSelection` projection, and picking a *different*
 * model sends that model's own `defaultEffort` — `efforts` pane and model list
 * agree on this (`dsh-client-ui-model-selection/lib/client.js:427,883`), and
 * the host resolver materializes the adapter default when a caller omits one
 * (`dsh-llm/lib/index.js:2116-2130`). A model switch therefore always lands on
 * the new model's default, and the level the user had chosen on the model they
 * left is not restored when they come back.
 *
 * WHAT it does: it remembers `(provider, model) -> last effort actually in
 * effect` and, when a live session's route changes to a model whose remembered
 * level that model still advertises, re-issues exactly one selection through
 * the public command interface. The durable log stays the single source of
 * truth: this plugin appends nothing itself, rewrites no in-memory selection
 * state, registers no service, and writes no settings.
 *
 * WHAT it deliberately does not do:
 *   - no client half, no slot, no UI — the picker already renders whatever the
 *     durable selection says, so one extra selection is all it takes;
 *   - no `agentDefaultModel`/settings write of its own (the public
 *     `selectModel` path performs the one settings write it always performs);
 *   - no retry and no user-visible failure: anything that cannot complete is
 *     logged and skipped, and the session stays exactly as the user left it.
 *
 * Restore is bounded by construction: only a *route change* can trigger it,
 * only when the event's own effort differs from the remembered one, and the
 * selection it re-issues keeps that same route — so the event it produces
 * cannot re-enter the rule as a change, and one switch costs at most one extra
 * `model/selection` record.
 *
 * @module dsh-effort-memory
 */

import { decide, effortId, outgoing, routeKey, seedFromProjection } from './decide.js'

/**
 * The plugin name. The bundle patch row must carry this exact id
 * (`dsh-effort-memory/cordis.patch.yml`), and the row's `name` must be this
 * package's name so the Loader resolves the code from the profile.
 */
export const name = 'effort-memory'

/**
 * Hard dependencies. Both are mounted in the shipped base + web composition:
 * the model catalog seam and the Session-addressed command face whose
 * `selectModel` is the GUI's own entry point. `storageDomain` and
 * `sessionProjections` are read optionally through `ctx.get` instead, so a
 * composition without them still applies this plugin.
 */
export const inject = ['llm', 'sessionController']

/**
 * The durable domain declaration.
 *
 * The domain name must match `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`,
 * `dsh-storage/lib/index.js:80`), which forbids the hyphen — hence
 * `effort_memory` while the row, package, and plugin keep `effort-memory`.
 *
 * `defineDomain`/`domainTable` are identity wrappers that only validate at
 * module load (`dsh-storage-domain/lib/index.js:46-47,61-76`), and the runtime
 * calls exactly one method on a table schema — `valueSchema.parse(raw)` while
 * loading stored records (`:371`). Writing that small parse here instead of
 * depending on zod and `@deepseek-ai/dsh-storage-domain` keeps this package
 * dependency-free, which matters for a `link:` install: pnpm does not install
 * the linked package's own dependencies, so a bare import of either would
 * resolve from this directory rather than from the profile.
 */
const DOMAIN = {
  name: 'effort_memory',
  version: 1,
  tables: {
    efforts: {
      valueSchema: {
        /** Validate one stored record at the durable boundary. */
        parse(raw) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('effort_memory: record must be an object')
          }
          const value = raw.reasoningEffort
          if (typeof value !== 'string' || value.length === 0) {
            throw new Error('effort_memory: record needs a non-empty reasoningEffort string')
          }
          return { reasoningEffort: value }
        },
      },
    },
  },
}

/** Read one error's message without ever throwing while reporting. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The per-model memory, over `ctx.storageDomain` when the composition mounts
 * it and over a process-local Map when it does not.
 *
 * Reads are synchronous: an opened domain serves them from validated in-memory
 * state, so the event path never waits on the medium to decide. Writes are
 * durable before they resolve and are fire-and-forget here — a failed write is
 * logged, never surfaced to the user, and the next event rewrites the same key
 * anyway. Every write goes through `write`, which waits for the domain to open
 * first: a write that raced the open would otherwise land in the Map and be
 * shadowed by the domain forever after.
 *
 * @param {object} ctx - the plugin context.
 * @returns {{ ready: Promise<void>, get: Function, write: Function }} the
 *   memory facade.
 */
function createMemory(ctx) {
  const fallback = new Map()
  let table
  let domain
  let closed = false

  const ready = (async () => {
    const storageDomain = ctx.get('storageDomain')
    if (storageDomain === undefined) {
      warn(ctx, 'storageDomain is not mounted; memory lives in this process only')
      return
    }
    try {
      const opened = await storageDomain.open(DOMAIN)
      if (closed) {
        // The plugin was stopped while the domain was opening: the facility
        // would close it eventually, but this fiber owns it now.
        await opened.close().catch(() => {})
        return
      }
      domain = opened
      table = opened.table('efforts')
    } catch (error) {
      warn(ctx, `storage domain unavailable, keeping memory in-process (${messageOf(error)})`)
    }
  })().catch(() => {
    /* `ready` is awaited on the event path: it must never reject */
  })

  ctx.effect(() => () => {
    closed = true
    const opened = domain
    domain = undefined
    table = undefined
    if (opened !== undefined) void opened.close().catch(() => {})
  }, 'effort-memory:domain')

  const get = (key) => {
    if (table !== undefined) {
      try {
        return table.get(key)?.reasoningEffort
      } catch {
        return undefined
      }
    }
    return fallback.get(key)
  }

  const put = (key, effort) => {
    try {
      if (table !== undefined) {
        void table.put(key, { reasoningEffort: effort }).catch((error) => {
          warn(ctx, `memory write failed (${messageOf(error)})`)
        })
        return
      }
      fallback.set(key, effort)
    } catch (error) {
      warn(ctx, `memory write failed (${messageOf(error)})`)
    }
  }

  return {
    ready,
    get,
    write(key, effort) {
      void ready.then(() => put(key, effort))
    },
  }
}

/** Log without ever letting logging itself break the host. */
function warn(ctx, text) {
  try {
    ctx.logger.warn(`effort-memory: ${text}`)
  } catch {
    /* a diagnostic must never become the failure */
  }
}

/** The effort ids one resolved model advertises; empty when it declares none. */
function effortIdsOf(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts)) return []
  return efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * Seed one session's tracked route from the durable projection, when the
 * composition serves it.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} session - the live session the event belongs to.
 * @returns {{ route: string, effort?: string } | undefined} the seed.
 */
function seedOf(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return undefined
  try {
    return seedFromProjection(projections.stateOf(session, 'modelSelection'))
  } catch {
    return undefined
  }
}

/**
 * Apply the effort memory.
 *
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
  const memory = createMemory(ctx)
  /** Per session: the route it is on and the effort last seen in effect there. */
  const sessions = new Map()
  /** Sessions with a restore in flight, so one session never re-issues twice. */
  const inflight = new Set()

  /**
   * Remember one effort for one route. Called only with the selection that is
   * genuinely in effect — the incoming event's effort, or the remembered value
   * once the re-issue has produced its own event.
   */
  const remember = (route, effort) => {
    if (effort !== undefined) memory.write(route, effort)
  }

  /**
   * Re-issue one remembered selection, validating capability first.
   *
   * `resolveModelInfo` is what makes the re-issue safe: `selectModel` resolves
   * the call config and *throws* `UNSUPPORTED_REASONING_EFFORT` for a level the
   * target does not advertise (`dsh-llm/lib/index.js:2119-2129`, wrapped by
   * `dsh-api-session-controller/lib/index.js:626-632`). Asking first turns that
   * into a silent no-op, which is the required behavior for a model whose
   * capability was removed or never declared.
   */
  async function reconcile({ sid, provider, model, route, incomingEffort }) {
    try {
      await memory.ready
      const remembered = memory.get(route)
      if (decide({ changed: true, remembered, incomingEffort, efforts: undefined }) !== 'probe') {
        remember(route, incomingEffort)
        return
      }
      const info = await ctx.llm.resolveModelInfo(provider, model)
      if (decide({ changed: true, remembered, incomingEffort, efforts: effortIdsOf(info) }) !== 'restore') {
        remember(route, incomingEffort)
        return
      }
      if (inflight.has(sid)) return
      inflight.add(sid)
      try {
        await ctx.sessionController.selectModel({ sessionId: sid, provider, model, reasoningEffort: remembered })
      } finally {
        inflight.delete(sid)
      }
    } catch (error) {
      warn(ctx, `skipped one restore for ${provider}/${model} (${messageOf(error)})`)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'model/selection') return
      // Constructor seeds — replay, fork, resume — never publish on this
      // firehose, and their seq stays below firstLiveSeq; the guard keeps the
      // plugin honest even if that ever changes
      // (`dsh-session/lib/types/index.d.ts:122-145`).
      if (event.seq < session.firstLiveSeq) return
      const sid = session.id
      const { provider, model } = event.data
      if (typeof provider !== 'string' || typeof model !== 'string') return
      const route = routeKey(provider, model)
      const incomingEffort = effortId(event.data)

      let prev = sessions.get(sid)
      if (prev === undefined) {
        prev = seedOf(ctx, session)
        if (prev !== undefined) sessions.set(sid, prev)
      }
      const changed = prev !== undefined && prev.route !== route

      // Track before any await: a concurrent event for this session must see
      // the new route, not the one being left.
      sessions.set(sid, { route, effort: incomingEffort })
      if (!changed) {
        // An effort-only change is the user's own choice on the route they are
        // already on: never re-issued, but exactly the value worth remembering —
        // including across a restart that lands before the next switch. With no
        // tracked route yet (`prev` undefined) this is that route's first event,
        // and its effort is just as much in effect.
        if (incomingEffort !== undefined && incomingEffort !== prev?.effort) remember(route, incomingEffort)
        return
      }

      const left = outgoing(prev)
      if (left !== undefined) remember(left.key, left.effort)
      void reconcile({ sid, provider, model, route, incomingEffort })
    } catch (error) {
      warn(ctx, `ignored one model/selection event (${messageOf(error)})`)
    }
  })
}
