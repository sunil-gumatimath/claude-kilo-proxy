// ============================================================================
// config.ts — Environment configuration (validated, immutable)
// ============================================================================

function envBool(key: string, fallback = false): boolean {
  const v = Bun.env[key];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envInt(key: string, fallback: number): number {
  const raw = Bun.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envStr(key: string, fallback: string): string {
  const v = Bun.env[key];
  return v == null || v === "" ? fallback : v;
}

export interface Config {
  /** Bind address — default 127.0.0.1 (local-only) */
  host: string;
  port: number;
  kiloApiKey: string;
  kiloBaseUrl: string;
  modelPrefix: string;
  defaultModel: string;
  debug: boolean;
  /** Upstream fetch timeout (ms) */
  upstreamTimeoutMs: number;
  /** Max JSON body size (bytes) */
  maxBodyBytes: number;
}

export function loadConfig(): Config {
  return {
    host: envStr("PROXY_HOST", "127.0.0.1"),
    port: envInt("PROXY_PORT", 4181),
    kiloApiKey: envStr("KILO_API_KEY", ""),
    kiloBaseUrl: envStr(
      "KILO_BASE_URL",
      "https://api.kilo.ai/api/gateway"
    ).replace(/\/+$/, ""),
    modelPrefix: Bun.env.MODEL_PREFIX ?? "anthropic/",
    defaultModel: envStr("DEFAULT_MODEL", "claude-sonnet-4-20250514"),
    debug: envBool("DEBUG", false),
    upstreamTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 20 * 1024 * 1024), // 20 MB
  };
}

export type { Config as AppConfig };
