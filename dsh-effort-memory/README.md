# dsh-effort-memory

Host-only DSH plugin: remember the reasoning effort that was **last actually in
effect** for each `(provider, model)` route, and restore it when a session
switches back to that model.

## Why

The composer's model seat renders the effort from the durable `modelSelection`
projection. Picking a *different* model sends that model's own `defaultEffort`
(`dsh-client-ui-model-selection/lib/client.js:427,883`), and the host resolver
materializes the adapter default when a caller omits an effort
(`dsh-llm/lib/index.js:2116-2130`). So a model switch always lands on the new
model's default, and the level chosen on the model being left is not restored on
return.

## Behavior

1. The memory key is `(provider, model)`; the value is the effort id that was
   last in effect on that route.
2. On a route change `A -> B`, the plugin remembers `A`'s effort, then:
   - if `B` has a remembered effort **and** `B` currently advertises it, it
     re-issues one selection through `ctx.sessionController.selectModel(...)`, so
     the session's durable selection becomes `{ B, that effort }`;
   - otherwise it does nothing and `B` keeps its own default. This is deliberate:
     a first visit to a never-used model lands on that model's default.
3. A target model that declares no reasoning capability (resolved `reasoning`
   missing, or `reasoningEfforts: false` in settings) gets no `reasoningEffort`
   and no error.
4. A remembered effort the target no longer advertises (for example rewritten by
   `dsh-custom-reasoning-effort`) falls back to the model's default silently, with
   no retry.
5. Effort-only changes on the model already selected are never touched.

## Design constraints

- **Host half only.** No `client.js`, no slot, no React, no UI.
- **One lever.** `ctx.sessionController.selectModel` — the same public command
  interface the GUI calls. The plugin never appends session events itself and
  never rewrites in-memory selection state.
- **Capability first.** `ctx.llm.resolveModelInfo(provider, model)` is consulted
  before any re-issue, because `selectModel` throws
  `UNSUPPORTED_REASONING_EFFORT` for a level the target does not advertise.
- **Loop-safe.** Only a *route change* can trigger a re-issue, only when the
  event's effort differs from the remembered one, and the re-issue keeps the same
  route — so the event it produces cannot re-enter the rule as a change.
- **Replay-safe.** Constructor seeds (replay, fork, resume) never publish on the
  `session/event` firehose; a `seq < session.firstLiveSeq` guard is kept as
  belt-and-braces.
- **No services, no settings, no retries.** Any failure is logged and skipped;
  nothing is ever surfaced to the user.
- **Zero runtime dependencies.** `defineDomain`/`domainTable` are identity
  wrappers and the runtime calls only `valueSchema.parse(raw)`, so the domain
  spec is declared inline; a `link:` install does not install a linked package's
  own dependencies, so a bare import of zod or
  `@deepseek-ai/dsh-storage-domain` would not resolve.

## Persistence

- Domain `effort_memory`, table `efforts`, key `JSON.stringify([provider, model])`,
  record `{ reasoningEffort }`.
- The domain name must match `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`, which forbids
  the hyphen — hence the domain is `effort_memory` while the package, the bundle
  patch row id, and the exported plugin name all stay `effort-memory`.
- With the base storage stack mounted, the `single`-layout document lands at
  `$DSH_HOME/storages/effort_memory.json` and survives restarts.
- Without `ctx.storageDomain`, memory degrades to a process-local `Map` (a warning
  is logged at apply time) and is lost on restart.

## Install

```
dsh plugin --profile <name> add link:<absolute path to this directory>
```

`dsh plugin` forwards to pnpm in the profile directory and then reconciles
`dsh.profile.bundles`: a dependency resolving to a package that declares
`dsh.bundle` joins the layer stack automatically. The new row and this Node ESM
module are both loaded at boot, so **a restart of `dsh` is required** after
installing or editing `index.js`.

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: event listener, service calls, storage memory (`apply`, `inject`, `name`) |
| `decide.js` | Pure rules: route keys, effort normalization, the decision table |
| `cordis.patch.yml` | The one bundle row (`id: effort-memory`, `name: dsh-effort-memory`) |
| `test/decide.test.mjs` | Pure-layer tests plus packaging parity assertions |
| `test/apply.test.mjs` | Integration test: the real `apply()` against a fake context |
| `test/all.mjs` | In-process entry point for both suites |

```
node test/all.mjs
```

(`node --test` is avoided on purpose: its per-file child process is refused under
a confined stdio sandbox.)

## Known limitations

1. One settings write per switch is performed by the public `selectModel` path
   itself (`agentDefaultModel.saveSelection` → `settings.replace('agent-default-model', …)`).
   This plugin adds no settings namespace and no settings write of its own.
2. Memory is global per `(provider, model)` — shared by every session and
   workspace, as specified.
3. The plugin acts on every live session whose route changes, subagent sessions
   included. Restricting to root sessions would require an extra `agents`
   dependency.
4. Without `sessionProjections`, the first event observed for an existing session
   can only establish the baseline, so that session's first switch after a restart
   may not be restored.
5. A stale remembered level is kept in the domain (harmless): if a model's effort
   table later regains that level, it will be restored again.
6. Single-process visibility only; `domain/changed` does not cross processes.

## License

[MIT](../LICENSE) © 2026 Jason Li
