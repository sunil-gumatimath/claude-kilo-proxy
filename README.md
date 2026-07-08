# ⚡ claude-kilo-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Use [Kilo Code](https://kilo.ai) models with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).**

A lightweight local proxy that translates between the **Anthropic Messages API** and **OpenAI Chat Completions** so Claude Code CLI can talk to Kilo Gateway (or any OpenAI-compatible API).

```
Claude Code CLI  ──(Anthropic format)──▶  claude-kilo-proxy  ──(OpenAI format)──▶  Kilo Gateway
                 ◀──(Anthropic format)──                      ◀──(OpenAI format)──
```

> **Disclaimer:** Unofficial community project. Not affiliated with, endorsed by, or sponsored by Anthropic or Kilo. APIs may change; use at your own risk.

## Why?

| Provider | Anthropic API (`/v1/messages`) | OpenAI API (`/chat/completions`) |
|---|---|---|
| OpenRouter | ✅ | ✅ |
| **Kilo Gateway** | **❌** | **✅** |

Claude Code speaks Anthropic format. Kilo speaks OpenAI format. This proxy bridges them.

## Features

- Full request/response translation (Anthropic ↔ OpenAI)
- Streaming (SSE) with real-time chunk translation
- Tool use / function calling support
- Image content support
- Multi-turn conversations with tool results
- Zero npm dependencies — just [Bun](https://bun.sh)
- Colored logging with debug mode
- Works with any OpenAI-compatible gateway

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A [Kilo](https://kilo.ai) API key (or another OpenAI-compatible endpoint)

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
# or with hot reload:
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

Then:

```bash
claude /logout
claude
```

You can also leave `KILO_API_KEY` empty in `.env` and pass the key only via `ANTHROPIC_AUTH_TOKEN` / `x-api-key` — the proxy forwards it to Kilo.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `KILO_API_KEY` | *(optional if sent in request)* | Your Kilo Code API key |
| `KILO_BASE_URL` | `https://api.kilo.ai/api/gateway` | Upstream base URL |
| `PROXY_PORT` | `4181` | Local port for the proxy |
| `MODEL_PREFIX` | `anthropic/` | Prefix added to model names for the gateway |
| `DEBUG` | `false` | Verbose request/response logging |

## How It Works

### Request translation (Anthropic → OpenAI)

- `system` (top-level) → `messages[0].role: "system"`
- `messages[].content[].type: "tool_use"` → `tool_calls[]`
- `messages[].content[].type: "tool_result"` → `role: "tool"` messages
- `tools[].input_schema` → `tools[].function.parameters`
- `stop_sequences` → `stop`
- Model name gets prefixed (e.g. `claude-sonnet-4-20250514` → `anthropic/claude-sonnet-4-20250514`)

### Response translation (streaming)

- OpenAI `data: {...}` chunks → Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`)
- `finish_reason: "stop"` → `stop_reason: "end_turn"`
- `finish_reason: "tool_calls"` → `stop_reason: "tool_use"`
- `delta.tool_calls[]` → `content_block` with `type: "tool_use"` + `input_json_delta`

## Other OpenAI-compatible gateways

Change `KILO_BASE_URL` (and usually clear the model prefix):

```bash
# Local Ollama example
KILO_BASE_URL=http://localhost:11434/v1 MODEL_PREFIX="" bun run start
```

## Security

- Intended for **local** use. Do not expose the proxy port to the public internet without additional authentication.
- Never commit `.env` — it is gitignored. Only `.env.example` is in the repo.
- `DEBUG=true` can log full request bodies (prompts). Avoid that on shared machines.

## Health check

```bash
curl http://localhost:4181/health
```

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © SuniL
