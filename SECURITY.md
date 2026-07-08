# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems that could expose API keys or remote code execution.

Email or privately message the maintainer (**TED**) with:

- Description of the issue
- Steps to reproduce
- Impact assessment

We will acknowledge reports as soon as possible and work on a fix before any public disclosure.

## Hardening notes for operators

- Default bind is **`127.0.0.1`** (localhost only). Do not set `PROXY_HOST=0.0.0.0` unless you have network controls and understand the risk.
- Treat this proxy as a **local adapter**, not a public multi-tenant API gateway.
- Never commit `.env` or API keys.
- Avoid `DEBUG=true` on shared machines (prompts may appear in logs; secrets are partially redacted but not guaranteed).
- Prefer short-lived API keys and rotate if leaked.
