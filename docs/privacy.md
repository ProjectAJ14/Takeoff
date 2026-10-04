# Privacy and egress

Takeoff runs locally. Every project starts Local only, and content leaves the
machine only through one code path, which a Local only project refuses. This page
says what the code enforces today, and what it does not.

## Local only, as enforced in code

There are two separate switches, and both default to local:

- **The project's provider policy** (`ProviderBroker.policy()`, project setting
  `providerPolicy`). Without a stored policy it is `LOCAL_ONLY`.
- **The plan's `settings.networkPolicy`** (`local_only` or `approved_providers`),
  which every edit plan must set explicitly.

What refuses egress:

| Function | Enforcement |
|---|---|
| `ProviderBroker.send` (`packages/engine/src/broker.ts`) | The only path that sends project content off the machine. With the policy `local_only` it throws `egress_denied` before reading a key or calling `fetch` (`privacy.test.ts` asserts zero fetch calls) |
| `ExternalDirector.propose` (`packages/director`) | Throws before calling its `send` when `settings.networkPolicy` is `local_only`; the engine then falls back to the rules director with no fetch |
| `OllamaDirector`, `ollamaModels` (capabilities), `planRequest` (plain-language requests) | The host is the constant `127.0.0.1`; redirects are refused |
| `startServer` (`packages/engine/src/server.ts`) | Listens on `127.0.0.1` only, behind a bearer token, a loopback Host check and an Origin check ([agents.md](agents.md#http-api)) |
| `openOverlay` (`packages/renderer-browser`) | The Chromium context is `offline`; every request outside the in-memory allowlist and every WebSocket is aborted and reported as `undeclared_network`, which QA treats as critical |
| Transcription worker | Sets `HF_HUB_OFFLINE=1` and loads models with `local_files_only=True`; only `download-model --allow-network` may reach the network |

The app makes no font or CDN request: render fonts come from the installed
`@fontsource` packages, and scene code is bundled locally.

## Approved providers

A project policy of `approved_providers` lists approvals of
`{provider, dataTypes, budgetUsd}`. `send` then allows a transfer only when:

- the provider is approved and is a known endpoint (only `anthropic` exists);
- the data type is approved for that provider (`transcript`, `frames`, `audio`,
  `video`, `asset_query`, `asset_download`, `prompt` or `brand_page`);
- the provider's recorded spend plus this send's estimate stays within the
  budget. A send without an estimate is charged a deliberately high one.

Before the request goes out, a `provider-receipt` is recorded in the project's
event log with the provider, data type, purpose, job, byte count, estimated cost
and the provider's retention-policy URL.

The HTTP API can set a project's provider policy
(`POST /v1/projects/{id}/providers`), but no CLI, MCP or HTTP call selects the
external director, the only caller of `send`. So no shipped command sends
content to a provider.

## What may download, and when

Only an explicit user action downloads anything:

- **The starter pack** (`takeoff starter-pack --allow-network`, or
  `POST /v1/starter-pack` with `{"allowNetwork": true}`) downloads the Whisper
  `base` model from Hugging Face through the worker's
  `download-model --model base --allow-network`, and only when that model is not
  already cached. Without the grant it fails as `network_denied`. With the model
  cached it needs no grant. The music and SFX library is generated locally by
  FFmpeg and downloads nothing.
- **The worker's own `download-model --allow-network`** command.

Setting up the tools (`npm install`, `npx playwright install`, `uv sync`) uses the
network; those are developer setup steps, not app actions.

## Logs

The engine logs to `<app data>/logs/engine.jsonl`. `redact` keeps only allowlisted
keys (ids, stage, durations, counts, codes, cache hits, QA outcome, revision) and
only strings that look like ids or codes: at most 40 characters, with no `/`, `\`
or spaces. Transcript text, file paths, prompts and keys are dropped
(`privacy.test.ts` runs a full pipeline and checks the log file). Errors carry a
code, a product message and a remedy; untyped errors keep only their class name.
FFmpeg stderr is never surfaced.

The diagnostic bundle (`writeDiagnostics`, HTTP `POST /v1/diagnostics`) writes
versions, the capabilities DTO and the logs redacted again, into a folder under
an approved root for the user to inspect before sharing.

## Credentials

Provider keys live in the macOS Keychain. `keychainKey(provider)` runs
`security find-generic-password -s takeoff.<provider> -w` with an argument
array and a 10 s timeout. The key is passed straight to the request header and
is never logged, stored in the project, written to an export bundle or put in a
diagnostic bundle. To add one:

```sh
security add-generic-password -s takeoff.anthropic -a takeoff -w
```

On other platforms the lookup fails as `credentials_unavailable`.

## Not enforced yet

- **No OS-level sandbox.** FFmpeg, the Python worker, Chromium and Ollama run
  as ordinary user processes. Local only is enforced by the code paths above,
  not by the operating system or a firewall. A dependency that opened its own
  connection would not be stopped.
- **Chromium's own sandbox is off.** The renderer does not set Playwright's
  `chromiumSandbox`, which defaults to `false`, so Chromium starts with
  `--no-sandbox`. The isolation is the offline context, the request allowlist
  and the absence of any Node bridge. Scenes are product code; generated scenes
  do not exist yet.
- **No network-denial trace.** Tests assert that the code makes no fetch in Local
  only mode; there is no OS-level trace of the whole app.
- **Keys on macOS only.** There is no Windows or Linux credential store.
- **Path checks.** Imports and destinations are checked with real paths; the
  renderer's "output is not an input" check is lexical.
