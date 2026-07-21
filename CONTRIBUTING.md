# Contributing

Thanks for helping improve **claude-code-proxy**.

## Development

```bash
cp .env.example .env   # set KILO_API_KEY if you need live calls
bun install
bun run dev            # hot reload
bun test               # unit tests
bun run typecheck
```

### Layout

| Path | Role |
|------|------|
| `src/translate.ts` | Anthropic ↔ OpenAI protocol |
| `src/handlers/messages.ts` | `/v1/messages` handler |
| `src/server.ts` | Routing, health, shutdown |
| `src/config.ts` | Environment config |
| `tests/` | Unit tests |

## Guidelines

1. **Keep runtime deps at zero** when possible (Bun built-ins only).
2. **Match Anthropic/OpenAI shapes** carefully — Claude Code is picky about SSE order.
3. **Don’t commit secrets** — `.env` is ignored; document new vars in `.env.example` and README.
4. **Add tests** for translator changes.
5. **Describe the change** — what broke, how you fixed it, how you tested.

## Pull requests

1. Fork and branch from `main`
2. Keep the PR focused
3. Ensure `bun test` passes
4. Summarize impact (streaming / tools / config)

## Reporting bugs

Include:

- Bun version (`bun --version`)
- OS
- Relevant env (port, prefix, gateway URL — **redact keys**)
- Logs (`DEBUG=true` if useful, redacted)
- Sync vs streaming, tools involved or not

## Code of conduct

Be respectful. Assume good intent. No harassment or spam.
