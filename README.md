# dsh-effort-memory

An out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) plugin that remembers the reasoning effort **last actually in effect** for
each `(provider, model)` route and restores it when a session switches back to
that model.

Stock behavior: picking a different model sends that model's own
`defaultEffort`, so a switch always lands on the new model's default and the
level chosen on the model you left is not restored on return. This plugin closes
that gap by re-issuing one selection through the same public command interface
the GUI calls — it appends no session events itself, registers no service, and
writes no settings.

- First visit to a never-used model still lands on that model's default (by design).
- A model that declares no reasoning capability gets no effort and no error.
- A remembered level the model no longer advertises falls back silently.

See [`dsh-effort-memory/README.md`](dsh-effort-memory/README.md) for the full
behavior contract, design constraints, persistence layout, and known limitations.

## Repository layout

| Path | Role |
|---|---|
| `dsh-effort-memory/` | The plugin package (the bundle: manifest, patch row, host half, tests) |
| `_verify/` | Verification harness used against a live harness: a dynamic host probe, a durable session-log extractor, and a mutation check |

## Install

Point a DSH profile at the package directory:

```
dsh plugin --profile <name> add link:<absolute path to>/dsh-effort-memory
```

`dsh plugin` forwards to pnpm in the profile directory and then reconciles
`dsh.profile.bundles`, so a dependency that declares `dsh.bundle` joins the layer
stack automatically. A new bundle row and its host module are loaded at boot:
**restart `dsh` afterwards**.

> The package currently lives in a subdirectory, so the `github:<owner>/<repo>`
> bundle spec (which resolves a repository root) does not apply. Flattening the
> package to the repository root would make
> `dsh plugin --profile <name> add github:<owner>/<repo>` work directly.

## Tests

```
cd dsh-effort-memory
node test/all.mjs
```

Twenty assertions: the pure decision table, packaging parity (bundle row id,
package name, storage-domain name), and an integration suite that drives the
real `apply()` against a fake Cordis context — listener shape, event ordering,
the re-issue loop breaker, replay-seed rejection, and the storage-less fallback.

`node --test` is deliberately not used: it runs each file in a child process with
piped stdio, which a confined sandbox refuses.

## License

[MIT](LICENSE) © 2026 Jason Li
