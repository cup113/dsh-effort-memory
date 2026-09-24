/**
 * dsh-effort-memory — pure decision layer.
 *
 * Every rule the plugin applies is a plain function over owned scalars: the
 * plugin's own `{ route, effort }` bookkeeping, the value it read out of
 * memory, and the effort ids the live model currently advertises. Keeping the
 * rules pure is what lets `node --test` exercise every branch without a Cordis
 * runtime, a live session, or a storage medium (see `test/decide.test.mjs`);
 * the impure half — services, events, the storage domain — stays in
 * `index.js`.
 *
 * @module dsh-effort-memory/decide
 */

/**
 * The composite memory key of one model route.
 *
 * A JSON tuple is unambiguous by construction, which a `/` or `:` join is not:
 * provider ids are slugs but model ids routinely carry separators of their own
 * (`deepseek/deepseek-v4.1-flash`), so a joined key could make two distinct
 * routes collide and silently share one remembered effort.
 *
 * @param {unknown} provider - registered provider route.
 * @param {unknown} model - provider-owned model id.
 * @returns {string} the memory key of that route.
 */
export function routeKey(provider, model) {
  return JSON.stringify([provider, model])
}

/**
 * The reasoning effort one `model/selection` record carries, normalized.
 *
 * The durable event omits `reasoningEffort` entirely for a route that declares
 * no reasoning capability, and the resolver materializes the adapter default
 * when the caller omitted one, so an absent field and an empty string both
 * mean "no effort in effect" (see `dsh-llm/lib/index.js:2116-2130`).
 *
 * @param {{ reasoningEffort?: unknown } | undefined | null} selection - event
 *   data or projection selection.
 * @returns {string | undefined} the effort id, or undefined when there is none.
 */
export function effortId(selection) {
  const value = selection?.reasoningEffort
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * What the session leaves behind when its route changes: exactly the effort
 * that was in effect on the route being left, keyed by that route.
 *
 * Both absences are meaningful and return undefined — there is no previous
 * route to remember (this is the first event the plugin observed for the
 * session), and the route being left declared no effort at all, so it has no
 * value worth remembering.
 *
 * @param {{ route: string, effort?: string } | undefined} prev - tracked
 *   session state before this event.
 * @returns {{ key: string, effort: string } | undefined} the memory write to
 *   perform, if any.
 */
export function outgoing(prev) {
  if (prev === undefined) return undefined
  const effort = typeof prev.effort === 'string' && prev.effort.length > 0 ? prev.effort : undefined
  if (effort === undefined) return undefined
  return { key: prev.route, effort }
}

/**
 * Seed one session's tracked route from the durable `modelSelection`
 * projection.
 *
 * Without this, the first event a freshly loaded plugin sees for an existing
 * session could only establish a baseline, so a switch performed as the very
 * first action after a restart would not be recognized as a route change and
 * its remembered effort would not be restored. The projection is derived from
 * the same session log the firehose feeds, so reading it adds no second source
 * of truth: `pending` is the latest appended selection, `lastUsed` the one a
 * request header materialized, and `pending ?? lastUsed` is what the model
 * seat itself renders (`dsh-api-session-controller/lib/index.js:2044-2088`).
 *
 * The seed must be read before the triggering event is appended — at
 * `session/created` — because `stateOf` materializes at the session's current
 * cursor and would otherwise already include that event, making the seed
 * equal to it (never a route change).
 *
 * @param {{ lastUsed?: unknown, pending?: unknown } | undefined} state -
 *   projection state, or undefined when the projection is unavailable.
 * @returns {{ route: string, effort?: string } | undefined} the seed, if the
 *   projection holds a usable selection.
 */
export function seedFromProjection(state) {
  const selection = state?.pending ?? state?.lastUsed
  if (selection === null || typeof selection !== 'object') return undefined
  const { provider, model } = selection
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { route: routeKey(provider, model), effort: effortId(selection) }
}

/**
 * The one rule table this plugin implements.
 *
 * `efforts === undefined` means the capability of the target route has not been
 * read yet, so the answer is `'probe'`: the caller must resolve the model info
 * and ask again with the advertised ids. Every other input is decidable
 * without any I/O, which is what keeps the common case (a route change with no
 * memory) free of a model-info lookup.
 *
 * @param {object} input - the decision inputs.
 * @param {boolean} input.changed - whether the session's route changed.
 * @param {string | undefined} input.remembered - remembered effort for the new
 *   route, if any.
 * @param {string | undefined} input.incomingEffort - effort this event already
 *   put in effect.
 * @param {readonly string[] | undefined} input.efforts - effort ids the target
 *   route advertises, or undefined when not yet resolved.
 * @returns {'none' | 'probe' | 'restore'} the action to take.
 */
export function decide({ changed, remembered, incomingEffort, efforts }) {
  // Only a route change can ever trigger a re-issue. An effort-only change is
  // the user's own choice on the model they are already on, and must never be
  // overridden — this is also what makes the plugin's own re-issue terminal:
  // the event it produces keeps the route, so it can never re-enter this rule
  // as a change.
  if (!changed) return 'none'
  // Never used before: the model keeps its own default, by design.
  if (remembered === undefined) return 'none'
  // Already in effect — either the model's default happens to equal the
  // remembered level, or this event IS the plugin's own re-issue settling.
  if (remembered === incomingEffort) return 'none'
  if (efforts === undefined) return 'probe'
  // The target route declares no reasoning capability, or the remembered level
  // was rewritten out of its table (dsh-custom-reasoning-effort edits exactly
  // this): fall back to the model's default silently, with no retry.
  if (!Array.isArray(efforts) || !efforts.includes(remembered)) return 'none'
  return 'restore'
}
