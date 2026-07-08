# Contributing

Thanks for helping improve **claude-kilo-proxy**.

## Development

```bash
cp .env.example .env   # set KILO_API_KEY if you need live calls
bun run dev            # hot reload
```

- Runtime: [Bun](https://bun.sh)
- Core logic: `src/translate.ts` (Anthropic ↔ OpenAI)
- Server: `src/index.ts`

## Guidelines

1. **Keep it small** — zero runtime npm dependencies preferred.
2. **Match Anthropic/OpenAI shapes** carefully; Claude Code is picky about SSE event order.
3. **Don’t commit secrets** — `.env` is ignored; use `.env.example` for new vars.
4. **Describe the change** — what broke, how you fixed it, how you tested.

## Pull requests

1. Fork and branch from `main`
2. Make a focused change
3. Open a PR with a short summary and test notes

## Reporting bugs

Include:

- Bun version (`bun --version`)
- OS
- Relevant env (port, `MODEL_PREFIX`, gateway URL — **redact API keys**)
- Proxy logs (with `DEBUG=true` if useful, redacted)
- Whether the issue is sync vs streaming, and if tools were involved

## Code of conduct

Be respectful. Assume good intent. No harassment or spam.
