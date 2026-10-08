<div align="center">

<img src="assets/logo.svg" width="128" alt="opencode-free-9router logo" />

# opencode-free-9router

**Expose the OpenCode Zen free-tier models as one OpenAI-compatible provider for 9Router.**
No OpenCode account, no API key, no subscription — just a local adapter.

Free models · attested free-tier client · OpenAI-compatible · zero dependencies

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](package.json)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI--compatible-6ea8fe?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/docs/api-reference/chat)
[![9Router](https://img.shields.io/badge/integrates-9Router-8b5cf6?style=flat-square)](https://9router.com)
[![OpenCode](https://img.shields.io/badge/upstream-opencode.ai-18181b?style=flat-square)](https://opencode.ai)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](https://github.com/0xgetz/opencode-free-9router/pulls)

[English](README.md) · [Indonesia](docs/README.id.md) · [Español](docs/README.es.md) · [日本語](docs/README.ja.md) · [中文](docs/README.zh.md)

</div>

---

## What it is

OpenCode ships a **free tier** — ten models you can use at no cost. Access is gated though:
the gateway answers `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`
unless the request carries the official client's fingerprint.

`opencode-free-9router` reproduces that fingerprint in a tiny local adapter, so **9Router — and
anything pointed at 9Router — can call these models for free.**

```
OpenAI client ──▶ 9Router :20128/v1 ──▶ provider-node "OpenCode Free"
              ──▶ adapter :8790/v1 ──▶ opencode.ai/zen/v1  (Bearer public + attestation)
```

> See **[STRUCTURE.md](STRUCTURE.md)** for the full topology, file map and data-flow diagrams.

> 9Router also ships its own `oc/`, `ocz/` and `opencode-go/` providers. This project is the
> standalone, auditable alternative: you own the adapter, see exactly what leaves your machine,
> and can point any OpenAI client at it with or without 9Router.

---

## The free models

Ten models are verified reachable end-to-end. Two endpoint families are used.

| Model | Endpoint | Context | Notes |
|-------|----------|---------|-------|
| `big-pickle` | chat/completions | 200K | general reasoning |
| `fledge-alpha-free` | chat/completions | 1M | text + image input |
| `ling-3.1-flash-free` | chat/completions | 262K | fast flash |
| `longcat-2.5-preview-free` | chat/completions | 1M | long context |
| `mimo-v2.6-flash-free` | chat/completions | 200K | compact flash |
| `nemotron-3-ultra-free` | chat/completions | 1M | large model |
| `nemotron-3.5-lightning-free` | chat/completions | 262K | low latency |
| `space-bunny-free` | chat/completions | 1M | 512K output |
| `muse-spark-1.2-contributor-free` | responses | 1M | contributor model |
| `muse-spark-1.3-contributor-free` | responses | 1M | contributor model |

**Known degraded** (reachable, upstream reports *Endpoint is unavailable*): `exo-free`,
`ling-3.0-flash-fin-free`. They are excluded from the default set but remain documented.

**Not proxied** (different wire protocol, SystemOne): `jev-1.13-free`. 9Router handles it natively.

Run `node src/cli.js list` for the current set.

---

## Quick start

Requires **Node.js >= 18**. There is nothing to install — zero dependencies.

```bash
git clone https://github.com/0xgetz/opencode-free-9router.git
cd opencode-free-9router

# 1. start the adapter (http://127.0.0.1:8790/v1)
node src/adapter.js

# 2. in another shell, register it in 9Router (9Router must be running)
node src/connect-9router.js
```

That's it. In 9Router the provider **OpenCode Free** now lists ten routable models.

### Try a model directly

```bash
node src/cli.js ask big-pickle "Explain closures in one line"
node src/cli.js check          # live-probe every working model
```

### Call the adapter like any OpenAI API

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"space-bunny-free","messages":[{"role":"user","content":"hi"}]}'
```

---

## How the free-tier gate works

The gateway only serves the free models to what it believes is the OpenCode client. The adapter
sends the exact attested fingerprint:

| Signal | Value |
|--------|-------|
| `User-Agent` | `opencode/<version>` (version >= 1.17) |
| `x-opencode-client` | `desktop` |
| `x-opencode-session` | `ses_<12 hex><14 base62>` — one stable id per identity |
| `x-opencode-request` | `msg_<12 hex><14 base62>` — one stable id per turn |
| `Authorization` | `Bearer public` |
| `stream` (body) | `true` — non-streaming requests are rejected |
| `tools` (body) | `bash`, `glob`, `grep`, `read` — the fingerprint quartet |

Session and request ids are generated locally with no network round-trip. Reusing one stable
session mirrors the real client and keeps free-tier accounting per conversation instead of per
request.

Everything above lives in [`src/opencode_free.js`](src/opencode_free.js) and is covered by
`node src/selftest.js`.

---

## Project layout

```
opencode-free-9router/
├── src/
│   ├── opencode_free.js     # attestation, ids, request shaping, one-shot complete()
│   ├── adapter.js           # OpenAI-compatible HTTP server (:8790/v1)
│   ├── connect-9router.js   # register the provider in 9Router
│   ├── cli.js               # list / ask / check
│   └── selftest.js          # offline + --live checks
├── docs/                    # translated READMEs
├── assets/                  # logo + social preview
└── STRUCTURE.md             # topology, file map, data-flow diagrams
```

---

## Testing

```bash
npm test              # offline: 11 checks, no network
npm run test:live     # also calls every free model (slow, ~8s between calls)
```

The live run is deliberately paced because the free tier rate-limits bursts.

---

## 9Router notes

`connect-9router.js` talks to a local 9Router at `http://127.0.0.1:20128`. It registers a custom
`openai-compatible` node and an API-key connection, then prints the live model ids.

Verified against **9Router v0.5.95**:

```
POST /api/provider-nodes  { name, prefix, baseUrl, type, apiType }   -> node
POST /api/providers       { provider, name, apiKey, baseUrl }        -> connection
GET  /v1/models                                                      -> <prefix>/<model>
POST /v1/chat/completions  (with a router API key)                   -> 200
```

Models appear in 9Router as `ocfree/<model>`. Override behaviour with:

| Variable | Default | Meaning |
|----------|---------|---------|
| `ROUTER_URL` | `http://127.0.0.1:20128` | 9Router base URL |
| `ADAPTER_URL` | `http://127.0.0.1:8790/v1` | this adapter's base URL |
| `ADAPTER_API_KEY` | `sk-opencode-free` | key the adapter expects (and 9Router sends) |
| `PROVIDER_NAME` | `OpenCode Free` | node name in the 9Router dashboard |
| `PROVIDER_PREFIX` | `ocfree` | model id prefix used by 9Router |
| `NINEROUTER_CLIENT` | auto-detected | path to 9Router's CLI API client |
| `NINEROUTER_CLI_TOKEN` | — | fallback device token for raw HTTP mode |
| `SKIP_CONNECTION` | — | set `1` to only create the node |

9Router protects these routes with a device CLI token. The connector auto-detects the installed
9Router package and reuses its own authenticated client; if it cannot, it falls back to raw HTTP
with `NINEROUTER_CLI_TOKEN`.

The adapter also honours `PORT`, `HOST`, `ADAPTER_API_KEY` and `QUIET`.

---

## Legal and fair use

This project is **unofficial** and not affiliated with OpenCode or 9Router. It uses the free tier
as the OpenCode client does. Free tiers have limits and change without notice — respect the
upstream terms of service, keep request volume reasonable, and do not resell the access. Use at
your own risk.

---

## License

[MIT](LICENSE) © 2026 0xgetz
