// ============================================================================
// handlers/messages.ts — POST /v1/messages
// ============================================================================

import type { Config } from "../config";
import { extractApiKey } from "../auth";
import { anthropicError, anthropicErrorSse, mapUpstreamErrorType } from "../errors";
import { colors, debug, error, log } from "../log";
import { beginRequest, getRuntime, recordFallback, recordUpstreamError } from "../runtime";
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
  let releaseSlot: (() => void) | undefined;
  let finishRequest: (() => void) | undefined;

  try {
    if (!isAuthorized(req, config.proxyApiKey)) {
      return anthropicError(401, "authentication_error", "Invalid proxy API key.");
    }

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
    finishRequest = beginRequest(isStream);

    log(
      `${cyan("→")} ${isStream ? "stream" : "  sync"} ${bold(originalModel)} ${dim(requestId)}`
    );
    debug("Anthropic request body", body);

    const openaiBody = translateRequest(
      body,
      config.modelPrefix,
      config.defaultModel
    );
    openaiBody.model = routeModel(openaiBody.model, body, config);
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

    let controller!: AbortController;
    let abortUpstream!: () => void;
    const runtime = getRuntime(config);
    releaseSlot = await runtime.limiter.acquire();
    if (!releaseSlot) {
      return anthropicError(429, "rate_limit_error", "Proxy is busy; try again shortly.");
    }

    const allCandidates = [...new Set([openaiBody.model, ...config.fallbackModels])];
    const candidateModels = allCandidates.filter((model) => !runtime.cooldowns.isCooling(model));
    if (!candidateModels.length) candidateModels.push(...allCandidates);
    let kiloRes: Response | undefined;

    for (let attempt = 0; attempt < candidateModels.length; attempt++) {
      const upstreamModel = candidateModels[attempt];
      openaiBody.model = upstreamModel;
      // Fresh controller per attempt so a prior timeout doesn't poison retries
      controller = new AbortController();
      abortUpstream = () => controller.abort("Client disconnected");
      req.signal.addEventListener("abort", abortUpstream, { once: true });
      const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

      try {
        const response = await fetch(kiloUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(openaiBody),
          signal: controller.signal,
          // Needed only for networks that intercept HTTPS with a locally-issued
          // certificate that is not in Bun's CA bundle.
        tls: config.upstreamTlsRejectUnauthorized && !config.upstreamCaFile
          ? undefined
          : {
              rejectUnauthorized: config.upstreamTlsRejectUnauthorized,
              ...(config.upstreamCaFile ? { ca: [Bun.file(config.upstreamCaFile)] } : {}),
            },
        });

        if (response.ok) {
          kiloRes = response;
          runtime.cooldowns.succeed(upstreamModel);
          if (attempt > 0) {
            recordFallback();
            log(`${green("↳")} fallback ${dim(upstreamModel)} ${dim(requestId)}`);
          }
          break;
        }

        const errText = await response.text();
        recordUpstreamError(response.status);
        if (response.status === 429 || response.status >= 500) {
          runtime.cooldowns.fail(upstreamModel);
        }
        if (canFallback(response.status, attempt, candidateModels.length)) {
          log(
            `${colors.yellow("↳")} upstream ${response.status} for ${dim(upstreamModel)}; ` +
              `trying ${dim(candidateModels[attempt + 1])} ${dim(requestId)}`
          );
          req.signal.removeEventListener("abort", abortUpstream);
          continue;
        }

        req.signal.removeEventListener("abort", abortUpstream);
        error(`Upstream ${response.status}: ${errText.slice(0, 200)}`);
        return anthropicError(
          response.status >= 400 && response.status < 600 ? response.status : 502,
          mapUpstreamErrorType(response.status),
          `Upstream returned ${response.status}: ${truncate(errText, 2000)}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          (err instanceof Error && err.name === "AbortError") || /abort/i.test(msg);
        if (isAbort) {
          req.signal.removeEventListener("abort", abortUpstream);
          error(`Upstream timeout after ${config.upstreamTimeoutMs}ms`);
          return anthropicError(
            504,
            "api_error",
            `Upstream timeout after ${config.upstreamTimeoutMs}ms`
          );
        }

        recordUpstreamError();
        runtime.cooldowns.fail(upstreamModel);

        if (attempt < candidateModels.length - 1) {
          log(
            `${colors.yellow("↳")} upstream connection failed for ${dim(upstreamModel)}; ` +
              `trying ${dim(candidateModels[attempt + 1])} ${dim(requestId)}`
          );
          req.signal.removeEventListener("abort", abortUpstream);
          continue;
        }

        req.signal.removeEventListener("abort", abortUpstream);
        error(`Upstream fetch failed: ${msg}`);
        return anthropicError(502, "api_error", `Failed to reach upstream: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!kiloRes) {
      req.signal.removeEventListener("abort", abortUpstream);
      return anthropicError(502, "api_error", "No upstream model was available.");
    }

    if (isStream) {
      const streamRelease = releaseSlot;
      const streamFinish = finishRequest;
      releaseSlot = undefined;
      finishRequest = undefined;
      return handleStream(kiloRes, originalModel, startTime, requestId, controller, () => {
        req.signal.removeEventListener("abort", abortUpstream);
        streamRelease?.();
        streamFinish?.();
      });
    }
    try {
      return await handleSync(kiloRes, originalModel, startTime, requestId);
    } finally {
      req.signal.removeEventListener("abort", abortUpstream);
    }
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
  } finally {
    releaseSlot?.();
    finishRequest?.();
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
  requestId: string,
  upstreamController: AbortController,
  cleanup: () => void
): Response {
  const translator = new StreamTranslator(model);
  const encoder = new TextEncoder();

  // Bun's Response body reader has extra methods beyond the web-standard type.
  let reader: any;
  let canceled = false;

  const safeEnqueue = (controller: ReadableStreamDefaultController, data: Uint8Array) => {
    if (canceled) return;
    try {
      controller.enqueue(data);
    } catch (e) {
      canceled = true;
    }
  };

  const safeClose = (controller: ReadableStreamDefaultController) => {
    if (canceled) return;
    canceled = true;
    try {
      controller.close();
    } catch (e) {
      // ignore
    }
  };

  const readable = new ReadableStream({
    async start(controller) {
      reader = kiloRes.body?.getReader();
      if (!reader) {
        for (const ev of translator.finalize("stop")) {
          safeEnqueue(controller, encoder.encode(ev));
        }
        safeClose(controller);
        cleanup();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!canceled) {
          const { done, value } = await reader.read();
          if (done || canceled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (canceled) break;
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;

            if (trimmed.startsWith("data:")) {
              const data = trimmed.startsWith("data: ")
                ? trimmed.slice(6)
                : trimmed.slice(5).trimStart();
              const events = translator.processChunk(data);
              for (const ev of events) {
                safeEnqueue(controller, encoder.encode(ev));
              }
            }
          }
        }

        if (!canceled && buffer.trim().startsWith("data:")) {
          const trimmed = buffer.trim();
          const data = trimmed.startsWith("data: ")
            ? trimmed.slice(6)
            : trimmed.slice(5).trimStart();
          for (const ev of translator.processChunk(data)) {
            safeEnqueue(controller, encoder.encode(ev));
          }
        }

        // Always close Anthropic stream cleanly
        if (!canceled) {
          for (const ev of translator.finalize("stop")) {
            safeEnqueue(controller, encoder.encode(ev));
          }
        }

        const elapsed = (performance.now() - startTime).toFixed(0);
        log(
          `${green("←")} stream ${dim(model)} complete ${dim(elapsed + "ms")} ${dim(requestId)}`
        );
        safeClose(controller);
      } catch (err) {
        if (canceled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Controller is already closed")) {
          error(`Stream error: ${msg}`);
        }
        safeEnqueue(
          controller,
          encoder.encode(anthropicErrorSse("api_error", msg))
        );
        for (const ev of translator.finalize("stop")) {
          safeEnqueue(controller, encoder.encode(ev));
        }
        safeClose(controller);
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          /* ignore */
        }
        cleanup();
      }
    },
    async cancel() {
      canceled = true;
      upstreamController.abort("Client stopped reading stream");
      try {
        await reader?.cancel();
      } catch {
        /* upstream is already closed */
      }
      cleanup();
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

/** When PROXY_API_KEY is unset the local proxy retains its existing behaviour. */
function isAuthorized(req: Request, expectedKey: string): boolean {
  if (!expectedKey) return true;
  const supplied = req.headers.get("x-proxy-api-key") || extractApiKey(req);
  if (supplied.length !== expectedKey.length) return false;
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i++) mismatch |= supplied.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  return mismatch === 0;
}

function canFallback(status: number, attempt: number, totalAttempts: number): boolean {
  return attempt < totalAttempts - 1 && (status === 408 || status === 429 || status >= 500);
}

function routeModel(
  requestedModel: string,
  body: AnthropicMessagesRequest,
  config: Config
): string {
  const requested = requestedModel.toLowerCase();
  if (!config.smartRouting || !requested.startsWith("claude-")) return requestedModel;
  const hasImage = body.messages?.some((message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === "image")
  );
  if (hasImage) return "nex-agi/nex-n2-pro:free";
  const alias = config.modelAliases.find(({ pattern }) => globMatches(pattern, requested));
  if (alias) return alias.model;
  return requestedModel;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
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
