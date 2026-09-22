/**
 * Verification probe — the body passed to `cordis_define` (kind: new, host
 * only), NOT part of the shipped package.
 *
 * It exists so the acceptance scenario can be driven and observed through the
 * same public commands the GUI uses, without touching the GUI, the product
 * source, or the plugin under test:
 *
 *   - `catalog`    reads `sessionController.modelCatalog()` (the picker's own
 *                  data) so routes and their `defaultEffort` are grounded in
 *                  what the product actually advertises;
 *   - `create`     makes a throwaway session that is never prompted, so no
 *                  model request is ever dispatched and no provider credential
 *                  is exercised;
 *   - `select`     calls `sessionController.selectModel(...)` — the identical
 *                  entry the composer calls — and then waits long enough for the
 *                  plugin's fire-and-forget re-issue to land;
 *   - `events`     returns the `model/selection` envelopes captured live from
 *                  the `session/event` firehose (seq included);
 *   - `projection` returns `sessionProjections.stateOf(session, 'modelSelection')`,
 *                  which is exactly what the model seat renders its effort from;
 *   - `archive`    hides the throwaway session afterwards.
 *
 * The host sandbox exposes only `ctx.get/on/provide/effect` plus the timer
 * verbs, so every service is reached through `ctx.get(...)`.
 */
const probeRoot = 'D:\\Projects\\dsh-persist-reasoning'

return {
  apply(ctx) {
    const captured = []

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'model/selection') return
      captured.push({
        seq: event.seq,
        sessionId: String(session.id),
        provider: event.data?.provider,
        model: event.data?.model,
        reasoningEffort: event.data?.reasoningEffort ?? null,
      })
    })

    const sleep = async (ms) => {
      const timer = ctx.get('timer')
      if (timer !== undefined) return timer.timeout(ms)
      return ctx.timeout(ms)
    }

    const forSession = (sessionId) =>
      sessionId === undefined ? captured.slice() : captured.filter((row) => row.sessionId === sessionId)

    const projectionOf = (sessionId) => {
      const sessions = ctx.get('sessions')
      const projections = ctx.get('sessionProjections')
      if (sessions === undefined || projections === undefined) return null
      const session = sessions.get(sessionId)
      if (session === undefined) return null
      const state = projections.stateOf(session, 'modelSelection')
      if (state === undefined) return null
      const plain = (selection) =>
        selection == null ? null : { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ?? null }
      return { lastUsed: plain(state.lastUsed), pending: plain(state.pending) }
    }

    const tool = harness.defineTool({
      name: 'effort_probe',
      description: 'Drive and observe the reasoning-effort memory scenario through the public session commands.',
      parameters: {
        action: { type: 'string', required: true, enum: ['catalog', 'create', 'select', 'events', 'projection', 'archive'] },
        sessionId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        waitMs: { type: 'number' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const controller = ctx.get('sessionController')
        if (controller === undefined) return 'no sessionController service'

        switch (args.action) {
          case 'catalog': {
            const catalog = await controller.modelCatalog()
            const groups = (catalog?.groups ?? []).map((group) => ({
              provider: group.id ?? group.provider,
              models: (group.models ?? []).map((entry) => ({
                model: entry.id,
                reasoning:
                  entry.reasoning === undefined
                    ? null
                    : {
                        defaultEffort: entry.reasoning.defaultEffort ?? null,
                        efforts: (entry.reasoning.efforts ?? []).map((effort) => effort.id),
                      },
              })),
            }))
            return JSON.stringify({ default: catalog?.default ?? null, groups }, null, 1)
          }
          case 'create': {
            const created = await controller.create({ cwd: probeRoot })
            return JSON.stringify({ created, events: forSession(created.sessionId) })
          }
          case 'select': {
            if (args.sessionId === undefined || args.provider === undefined || args.model === undefined) {
              return 'sessionId, provider, and model are required'
            }
            let outcome
            try {
              const result = await controller.selectModel({
                sessionId: args.sessionId,
                provider: args.provider,
                model: args.model,
                ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
              })
              outcome = { ok: true, selected: result?.selected ?? null }
            } catch (error) {
              outcome = { ok: false, error: String(error?.message ?? error) }
            }
            await sleep(args.waitMs ?? 1500)
            return JSON.stringify({ outcome, events: forSession(args.sessionId), projection: projectionOf(args.sessionId) })
          }
          case 'events':
            return JSON.stringify({ events: forSession(args.sessionId) })
          case 'projection':
            return JSON.stringify(projectionOf(args.sessionId))
          case 'archive': {
            const workspaces = ctx.get('workspaceController')
            if (workspaces === undefined) return 'no workspaceController service'
            await workspaces.archiveSession(args.sessionId)
            return JSON.stringify({ archived: args.sessionId })
          }
          default:
            return `unknown action ${String(args.action)}`
        }
      },
    })

    harness.registerTool(ctx, tool)
  },
}
