# ⚡ claude-kilo-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Use [Kilo Code](https://kilo.ai) models with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).**

Production-oriented local proxy that translates **Anthropic Messages API** ↔ **OpenAI Chat Completions** so Claude Code can use Kilo Gateway (or any OpenAI-compatible API).

```
Claude Code CLI  ──(Anthropic format)──▶  claude-kilo-proxy  ──(OpenAI format)──▶  Kilo Gateway
                 ◀──(Anthropic format)──                      ◀──(OpenAI format)──
```

> **Disclaimer:** Unofficial community project. Not affiliated with, endorsed by, or sponsored by Anthropic or Kilo. APIs may change; use at your own risk.

## Features

- Full request/response translation (Anthropic ↔ OpenAI)
- Streaming (SSE) with reliable stream finalization
- Tool use / function calling (including multi-turn tool results)
- Image content support
- Upstream timeouts, body size limits, request IDs
- Localhost-only bind by default
- Graceful shutdown (SIGINT / SIGTERM)
- Debug logging with secret/base64 redaction
- Zero runtime npm dependencies — [Bun](https://bun.sh) only
- Docker image included
- Unit tests for the translator

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A [Kilo](https://kilo.ai) API key (or another OpenAI-compatible endpoint)

> **Full walkthrough:** see **[SETUP.md](./SETUP.md)** (install Bun, `.env`, Claude Code env vars, Docker, troubleshooting).

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/YOUR_USERNAME/claude-kilo-proxy.git
cd claude-kilo-proxy
cp .env.example .env
# Edit .env and set KILO_API_KEY
```

### 2. Start the proxy

```bash
bun run start
# hot reload:
bun run dev
```

### 3. Point Claude Code at the proxy

**PowerShell:**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:4181"
$env:ANTHROPIC_AUTH_TOKEN = "your-kilo-api-key"
$env:ANTHROPIC_API_KEY = ""
```

**Bash / Zsh:**

```bash
export ANTHROPIC_BASE_URL="http://localhost:4181"
export ANTHROPIC_AUTH_TOKEN="your-kilo-api-key"
export ANTHROPIC_API_KEY=""
```

```bash
claude /logout
claude
```

You can leave `KILO_API_KEY` empty and pass the key only via `ANTHROPIC_AUTH_TOKEN` / `x-api-key`.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `KILO_API_KEY` | *(optional if sent on request)* | Upstream API key |
| `KILO_BASE_URL` | `https://api.kilo.ai/api/gateway` | Upstream base URL |
| `PROXY_HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `PROXY_PORT` | `4181` | Listen port |
| `MODEL_PREFIX` | `anthropic/` | Prefix added to model names |
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Fallback when request omits `model` |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `MAX_BODY_BYTES` | `20971520` (20MB) | Max request body size |
| `DEBUG` | `false` | Verbose logging (redacted) |

## Project structure

```
src/
  index.ts              # Entry
  config.ts             # Env config
  server.ts             # HTTP routing + lifecycle
  auth.ts               # API key extraction
  errors.ts             # Anthropic-shaped errors
  log.ts                # Logging + redaction
  types.ts              # Shared types
  version.ts            # Package version
  translate.ts          # Anthropic ↔ OpenAI core
  handlers/
    messages.ts         # POST /v1/messages
tests/
  translate.test.ts
Dockerfile
```

## Docker

```bash
docker build -t claude-kilo-proxy .
docker run --rm -p 4181:4181 \
  -e KILO_API_KEY=your-key \
  claude-kilo-proxy
```

> Container sets `PROXY_HOST=0.0.0.0` so port publishing works. Keep the host firewall tight.

## Other OpenAI-compatible gateways

```bash
KILO_BASE_URL=http://localhost:11434/v1 MODEL_PREFIX="" bun run start
```

## Health & version

```bash
curl http://localhost:4181/health
curl http://localhost:4181/version
```

## Development

```bash
bun install          # devDependencies (types, typescript)
bun test             # unit tests
bun run typecheck    # tsc --noEmit
bun run dev          # hot reload
```

## Security

- Default bind is **localhost only** (`PROXY_HOST=127.0.0.1`).
- Do not expose the port to the public internet without additional auth.
- Never commit `.env`.
- See [SECURITY.md](./SECURITY.md).

## How it works

### Request (Anthropic → OpenAI)

- `system` → `messages[0].role: "system"`
- `tool_use` → `tool_calls[]`
- `tool_result` → `role: "tool"`
- `tools[].input_schema` → `tools[].function.parameters`
- Model prefixed for gateway routing

### Streaming (OpenAI → Anthropic SSE)

- Chunks → `message_start` / `content_block_*` / `message_delta` / `message_stop`
- `finish_reason: tool_calls` → `stop_reason: tool_use`
- Stream always finalized if upstream closes early

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © TED
