// ============================================================================
// server.ts — HTTP server (routing + lifecycle)
// ============================================================================

import type { Config } from "./config";
import { anthropicError } from "./errors";
import { handleMessages } from "./handlers/messages";
import { colors, banner, log, setDebug } from "./log";
import { NAME, VERSION } from "./version";

const { cyan, green, dim, bold, yellow } = colors;

export function createServer(config: Config) {
  setDebug(config.debug);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 255, // max allowed by Bun (seconds) for long streams

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // CORS preflight (optional clients)
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(req),
        });
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/health" ||
          url.pathname === "/healthz")
      ) {
        return Response.json(
          {
            status: "ok",
            proxy: NAME,
            version: VERSION,
            target: config.kiloBaseUrl,
            uptime_s: Math.floor(process.uptime()),
          },
          {
            headers: {
              "Cache-Control": "no-store",
              ...corsHeaders(req),
            },
          }
        );
      }

      if (req.method === "GET" && url.pathname === "/version") {
        return Response.json(
          { name: NAME, version: VERSION },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const res = await handleMessages(req, config);
        // Attach CORS on JSON errors / sync responses when Origin present
        const origin = req.headers.get("origin");
        if (origin && res.headers.get("content-type")?.includes("json")) {
          const headers = new Headers(res.headers);
          for (const [k, v] of Object.entries(corsHeaders(req))) {
            headers.set(k, v);
          }
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
        return res;
      }

      return anthropicError(
        404,
        "not_found",
        `Unknown route: ${req.method} ${url.pathname}`
      );
    },

    error(err) {
      log(`${colors.red("✗")} Unhandled server error: ${err.message}`);
      return anthropicError(500, "api_error", "Internal server error");
    },
  });

  printBanner(config);
  setupGracefulShutdown(server);

  return server;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  // Local-dev friendly: reflect Origin only when present (not wide-open *)
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function printBanner(config: Config) {
  banner([
    bold(`  ⚡ ${NAME} v${VERSION}`),
    "",
    `  ${dim("Listen:")}        ${cyan(`http://${config.host}:${config.port}`)}`,
    `  ${dim("Target:")}        ${cyan(config.kiloBaseUrl)}`,
    `  ${dim("Model prefix:")}  ${cyan(`"${config.modelPrefix}"`)}`,
    `  ${dim("API key:")}       ${
      config.kiloApiKey
        ? green("✓ from KILO_API_KEY")
        : dim("⚠ from request headers")
    }`,
    `  ${dim("Upstream TO:")}   ${cyan(`${config.upstreamTimeoutMs}ms`)}`,
    `  ${dim("Max body:")}      ${cyan(formatBytes(config.maxBodyBytes))}`,
    `  ${dim("Debug:")}         ${config.debug ? green("ON") : dim("off")}`,
    "",
    config.host === "0.0.0.0" || config.host === "::"
      ? `  ${yellow("⚠ Bound on all interfaces — do not expose without auth")}`
      : `  ${dim("Bound localhost-only (set PROXY_HOST=0.0.0.0 to change)")}`,
    `  ${green("Ready")} → http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/v1/messages`,
  ]);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function setupGracefulShutdown(server: ReturnType<typeof Bun.serve>) {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (${signal})…`);
    try {
      server.stop(true);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
