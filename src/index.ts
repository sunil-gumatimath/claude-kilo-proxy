// ============================================================================
// index.ts — Kilo Proxy Server
// Accepts Anthropic Messages API requests, translates to OpenAI format,
// forwards to Kilo Code Gateway, and translates the response back.
// ============================================================================

import {
  translateRequest,
  translateResponse,
  StreamTranslator,
  uid,
} from "./translate";

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = Number(Bun.env.PROXY_PORT) || 4181;
const KILO_API_KEY = Bun.env.KILO_API_KEY || "";
const KILO_BASE_URL = (
  Bun.env.KILO_BASE_URL || "https://api.kilo.ai/api/gateway"
).replace(/\/+$/, "");
const MODEL_PREFIX = Bun.env.MODEL_PREFIX ?? "anthropic/";
const DEBUG = Bun.env.DEBUG === "true" || Bun.env.DEBUG === "1";

// ─── Logging ────────────────────────────────────────────────────────────────

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function log(msg: string) {
  console.log(`${dim(new Date().toISOString())} ${msg}`);
}

function debug(msg: string, data?: any) {
  if (!DEBUG) return;
  console.log(`${dim(new Date().toISOString())} ${dim("[DEBUG]")} ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health check
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        status: "ok",
        proxy: "claude-kilo-proxy",
        version: "1.0.0",
        target: KILO_BASE_URL,
      });
    }

    // Main endpoint — Anthropic Messages API
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return handleMessages(req);
    }

    return Response.json(
      { type: "error", error: { type: "not_found", message: `Unknown route: ${url.pathname}` } },
      { status: 404 }
    );
  },
});

// ─── Request Handler ────────────────────────────────────────────────────────

async function handleMessages(req: Request): Promise<Response> {
  const startTime = performance.now();

  try {
    const body = await req.json();
    const originalModel = body.model || "claude-sonnet-4-20250514";
    const isStream = body.stream === true;

    log(`${cyan("→")} ${isStream ? "stream" : "  sync"} ${bold(originalModel)}`);
    debug("Anthropic request body", body);

    // Translate Anthropic → OpenAI
    const openaiBody = translateRequest(body, MODEL_PREFIX);
    debug("Translated OpenAI body", openaiBody);

    // Resolve API key: env var takes priority, then extract from request headers
    const apiKey = KILO_API_KEY || extractApiKey(req);
    if (!apiKey) {
      log(`${red("✗")} No API key — set KILO_API_KEY env var or pass via header`);
      return anthropicError(401, "authentication_error",
        "No API key. Set KILO_API_KEY or pass via x-api-key / Authorization header.");
    }

    // Forward to Kilo Gateway
    const kiloUrl = `${KILO_BASE_URL}/chat/completions`;
    debug(`Forwarding to: ${kiloUrl}`);

    const kiloRes = await fetch(kiloUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiBody),
    });

    if (!kiloRes.ok) {
      const errText = await kiloRes.text();
      log(`${red("✗")} Kilo ${kiloRes.status}: ${errText.slice(0, 200)}`);
      return anthropicError(kiloRes.status, "api_error",
        `Kilo Gateway returned ${kiloRes.status}: ${errText}`);
    }

    // ── Route to sync or streaming handler ──
    if (isStream) {
      return handleStream(kiloRes, originalModel, startTime);
    } else {
      return handleSync(kiloRes, originalModel, startTime);
    }
  } catch (err: any) {
    log(`${red("✗")} Proxy error: ${err.message}`);
    return anthropicError(500, "api_error", err.message);
  }
}

// ─── Sync Response ──────────────────────────────────────────────────────────

async function handleSync(
  kiloRes: Response,
  model: string,
  startTime: number
): Promise<Response> {
  const openaiResult = await kiloRes.json();
  debug("OpenAI response", openaiResult);

  const anthropicResult = translateResponse(openaiResult, model);
  const elapsed = (performance.now() - startTime).toFixed(0);

  log(
    `${green("←")}   sync ${dim(model)} ` +
    `stop=${anthropicResult.stop_reason} ` +
    `in=${anthropicResult.usage.input_tokens} out=${anthropicResult.usage.output_tokens} ` +
    `${dim(elapsed + "ms")}`
  );

  return Response.json(anthropicResult, {
    headers: {
      "Content-Type": "application/json",
      "x-request-id": `req_${uid()}`,
    },
  });
}

// ─── Streaming Response ─────────────────────────────────────────────────────

function handleStream(
  kiloRes: Response,
  model: string,
  startTime: number
): Response {
  const translator = new StreamTranslator(model);
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const reader = kiloRes.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // keep the incomplete last line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue; // skip empty / comments

            if (trimmed.startsWith("data: ")) {
              const data = trimmed.slice(6);
              const events = translator.processChunk(data);
              for (const ev of events) {
                controller.enqueue(encoder.encode(ev));
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim().startsWith("data: ")) {
          const data = buffer.trim().slice(6);
          const events = translator.processChunk(data);
          for (const ev of events) {
            controller.enqueue(encoder.encode(ev));
          }
        }

        const elapsed = (performance.now() - startTime).toFixed(0);
        log(`${green("←")} stream ${dim(model)} complete ${dim(elapsed + "ms")}`);
      } catch (err: any) {
        log(`${red("✗")} Stream error: ${err.message}`);
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-request-id": `req_${uid()}`,
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractApiKey(req: Request): string {
  const xKey = req.headers.get("x-api-key");
  if (xKey) return xKey;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return "";
}

function anthropicError(status: number, type: string, message: string): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status }
  );
}

// ─── Startup Banner ─────────────────────────────────────────────────────────

console.log("");
console.log(bold("  ⚡ claude-kilo-proxy v1.0.0"));
console.log("");
console.log(`  ${dim("Port:")}          ${cyan(String(PORT))}`);
console.log(`  ${dim("Target:")}        ${cyan(KILO_BASE_URL)}`);
console.log(`  ${dim("Model prefix:")}  ${cyan(`"${MODEL_PREFIX}"`)}`);
console.log(`  ${dim("API key:")}       ${KILO_API_KEY ? green("✓ from KILO_API_KEY") : dim("⚠ from request headers")}`);
console.log(`  ${dim("Debug:")}         ${DEBUG ? green("ON") : dim("off")}`);
console.log("");
console.log(`  ${green("Ready")} → http://localhost:${PORT}/v1/messages`);
console.log("");
