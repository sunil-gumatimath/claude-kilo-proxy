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
  /** Optional shared secret required from clients before requests are forwarded. */
  proxyApiKey: string;
  kiloBaseUrl: string;
  modelPrefix: string;
  defaultModel: string;
  fallbackModels: string[];
  modelAliases: Array<{ pattern: string; model: string }>;
  smartRouting: boolean;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  modelCooldownMs: number;
  debug: boolean;
  /** Upstream fetch timeout (ms) */
  upstreamTimeoutMs: number;
  /** Verify the TLS certificate supplied by the upstream (keep enabled normally). */
  upstreamTlsRejectUnauthorized: boolean;
  upstreamCaFile: string;
  /** Max JSON body size (bytes) */
  maxBodyBytes: number;
  /** Comma-separated browser origins permitted to call this proxy. */
  corsAllowedOrigins: string[];
}

export function loadConfig(): Config {
  return {
    host: envStr("PROXY_HOST", "127.0.0.1"),
    port: envInt("PROXY_PORT", 4181),
    kiloApiKey: envStr("KILO_API_KEY", ""),
    proxyApiKey: envStr("PROXY_API_KEY", ""),
    kiloBaseUrl: envStr(
      "KILO_BASE_URL",
      "https://api.kilo.ai/api/gateway"
    ).replace(/\/+$/, ""),
    // Preserve Claude Code's requested model name unless the gateway requires a prefix.
    modelPrefix: Bun.env.MODEL_PREFIX ?? "",
    defaultModel: envStr("DEFAULT_MODEL", "claude-sonnet-4-20250514"),
    fallbackModels: (Bun.env.FALLBACK_MODELS ??
      "nex-agi/nex-n2-pro:free,poolside/laguna-m.1:free")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    modelAliases: parseAliases(
      Bun.env.MODEL_ALIASES ??
        "*haiku*=inclusionai/ling-2.6-flash:free,*sonnet*=tencent/hy3:free,*opus*=poolside/laguna-m.1:free"
    ),
    smartRouting: envBool("SMART_ROUTING", true),
    maxConcurrentRequests: envInt("MAX_CONCURRENT_REQUESTS", 4),
    maxQueuedRequests: envInt("MAX_QUEUED_REQUESTS", 20),
    modelCooldownMs: envInt("MODEL_COOLDOWN_MS", 30_000),
    debug: envBool("DEBUG", false),
    upstreamTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    upstreamTlsRejectUnauthorized: envBool("UPSTREAM_TLS_REJECT_UNAUTHORIZED", true),
    upstreamCaFile: envStr("UPSTREAM_CA_FILE", ""),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 20 * 1024 * 1024), // 20 MB
    corsAllowedOrigins: (Bun.env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

function parseAliases(raw: string): Array<{ pattern: string; model: string }> {
  return raw.split(",").flatMap((entry) => {
    const [pattern, model] = entry.split("=").map((part) => part.trim());
    return pattern && model ? [{ pattern: pattern.toLowerCase(), model }] : [];
  });
}

export type { Config as AppConfig };
