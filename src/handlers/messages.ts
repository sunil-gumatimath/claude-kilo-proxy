// ============================================================================
// handlers/messages.ts — POST /v1/messages
// ============================================================================

import type { Config } from "../config";
import { extractApiKey } from "../auth";
import { anthropicError, anthropicErrorSse, mapUpstreamErrorType } from "../errors";
import { colors, debug, error, log } from "../log";
import {
  StreamTranslator,
  translateRequest,
  translateResponse,
  uid,
} from "../translate";
import type { AnthropicMessagesRequest, OpenAIChatResponse } from "../types";

const { cyan, green, bold, dim } = colors;

export async function handleMessages(
  req: Request,
  config: Config
): Promise<Response> {
  const startTime = performance.now();
  const requestId = `req_${uid()}`;

  try {
    const bodyText = await readBodyLimited(req, config.maxBodyBytes);
    let body: AnthropicMessagesRequest;
    try {
      body = JSON.parse(bodyText) as AnthropicMessagesRequest;
    } catch {
      return anthropicError(
        400,
        "invalid_request_error",
        "Request body must be valid JSON."
      );
    }

    const originalModel = body.model || config.defaultModel;
    const isStream = body.stream === true;

    log(
      `${cyan("→")} ${isStream ? "stream" : "  sync"} ${bold(originalModel)} ${dim(requestId)}`
    );
    debug("Anthropic request body", body);

    const openaiBody = translateRequest(
      body,
      config.modelPrefix,
      config.defaultModel
    );
    debug("Translated OpenAI body", openaiBody);

    const apiKey = config.kiloApiKey || extractApiKey(req);
    if (!apiKey) {
      error("No API key — set KILO_API_KEY or pass via header");
      return anthropicError(
        401,
        "authentication_error",
        "No API key. Set KILO_API_KEY or pass via x-api-key / Authorization header."
      );
    }

    const kiloUrl = `${config.kiloBaseUrl}/chat/completions`;
    debug(`Forwarding to: ${kiloUrl}`);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.upstreamTimeoutMs
    );

    let kiloRes: Response;
    try {
      kiloRes = await fetch(kiloUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(openaiBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        /abort/i.test(msg);
      error(
        isAbort
          ? `Upstream timeout after ${config.upstreamTimeoutMs}ms`
          : `Upstream fetch failed: ${msg}`
      );
      return anthropicError(
        isAbort ? 504 : 502,
        "api_error",
        isAbort
          ? `Upstream timeout after ${config.upstreamTimeoutMs}ms`
          : `Failed to reach upstream: ${msg}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!kiloRes.ok) {
      const errText = await kiloRes.text();
      error(`Upstream ${kiloRes.status}: ${errText.slice(0, 200)}`);
      return anthropicError(
        kiloRes.status >= 400 && kiloRes.status < 600 ? kiloRes.status : 502,
        mapUpstreamErrorType(kiloRes.status),
        `Upstream returned ${kiloRes.status}: ${truncate(errText, 2000)}`
      );
    }

    if (isStream) {
      return handleStream(kiloRes, originalModel, startTime, requestId);
    }
    return handleSync(kiloRes, originalModel, startTime, requestId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "BODY_TOO_LARGE") {
      return anthropicError(
        413,
        "invalid_request_error",
        `Request body exceeds MAX_BODY_BYTES (${config.maxBodyBytes}).`
      );
    }
    error(`Proxy error: ${msg}`);
    return anthropicError(500, "api_error", msg);
  }
}

async function handleSync(
  kiloRes: Response,
  model: string,
  startTime: number,
  requestId: string
): Promise<Response> {
  const openaiResult = (await kiloRes.json()) as OpenAIChatResponse;
  debug("OpenAI response", openaiResult);

  const anthropicResult = translateResponse(openaiResult, model);
  const elapsed = (performance.now() - startTime).toFixed(0);

  log(
    `${green("←")}   sync ${dim(model)} ` +
      `stop=${anthropicResult.stop_reason} ` +
      `in=${anthropicResult.usage.input_tokens} out=${anthropicResult.usage.output_tokens} ` +
      `${dim(elapsed + "ms")} ${dim(requestId)}`
  );

  return Response.json(anthropicResult, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
}

function handleStream(
  kiloRes: Response,
  model: string,
  startTime: number,
  requestId: string
): Response {
  const translator = new StreamTranslator(model);
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const reader = kiloRes.body?.getReader();
      if (!reader) {
        for (const ev of translator.finalize("stop")) {
          controller.enqueue(encoder.encode(ev));
        }
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
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;

            if (trimmed.startsWith("data:")) {
              const data = trimmed.startsWith("data: ")
                ? trimmed.slice(6)
                : trimmed.slice(5).trimStart();
              const events = translator.processChunk(data);
              for (const ev of events) {
                controller.enqueue(encoder.encode(ev));
              }
            }
          }
        }

        if (buffer.trim().startsWith("data:")) {
          const trimmed = buffer.trim();
          const data = trimmed.startsWith("data: ")
            ? trimmed.slice(6)
            : trimmed.slice(5).trimStart();
          for (const ev of translator.processChunk(data)) {
            controller.enqueue(encoder.encode(ev));
          }
        }

        // Always close Anthropic stream cleanly
        for (const ev of translator.finalize("stop")) {
          controller.enqueue(encoder.encode(ev));
        }

        const elapsed = (performance.now() - startTime).toFixed(0);
        log(
          `${green("←")} stream ${dim(model)} complete ${dim(elapsed + "ms")} ${dim(requestId)}`
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Stream error: ${msg}`);
        try {
          controller.enqueue(
            encoder.encode(anthropicErrorSse("api_error", msg))
          );
          for (const ev of translator.finalize("stop")) {
            controller.enqueue(encoder.encode(ev));
          }
        } catch {
          /* controller may already be closed */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-request-id": requestId,
      "X-Accel-Buffering": "no",
    },
  });
}

async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw new Error("BODY_TOO_LARGE");
  }

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return decoder.decode(merged);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
