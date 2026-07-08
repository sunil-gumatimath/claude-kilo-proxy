// ============================================================================
// translate.ts — Anthropic Messages API ↔ OpenAI Chat Completions translator
// ============================================================================

// ─── Request Translation (Anthropic → OpenAI) ──────────────────────────────

export function translateRequest(body: any, modelPrefix: string): any {
  const openai: any = {};

  // Model — add prefix for gateway routing (e.g. "anthropic/claude-sonnet-4-20250514")
  const model = body.model || "claude-sonnet-4-20250514";
  openai.model = model.startsWith(modelPrefix) ? model : modelPrefix + model;

  // ── Messages ──
  const messages: any[] = [];

  // System prompt → system message (first in array)
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  // Translate each message
  for (const msg of body.messages || []) {
    messages.push(...translateMessage(msg));
  }
  openai.messages = messages;

  // ── Parameters ──
  if (body.max_tokens != null) openai.max_tokens = body.max_tokens;
  if (body.temperature != null) openai.temperature = body.temperature;
  if (body.top_p != null) openai.top_p = body.top_p;
  if (body.stop_sequences) openai.stop = body.stop_sequences;
  if (body.stream != null) openai.stream = body.stream;

  // Request usage stats in streaming mode
  if (body.stream) {
    openai.stream_options = { include_usage: true };
  }

  // ── Tools ──
  if (body.tools?.length) {
    openai.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object" },
      },
    }));
  }

  // ── Tool Choice ──
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") {
      openai.tool_choice = "auto";
    } else if (body.tool_choice.type === "any") {
      openai.tool_choice = "required";
    } else if (body.tool_choice.type === "tool") {
      openai.tool_choice = {
        type: "function",
        function: { name: body.tool_choice.name },
      };
    } else if (body.tool_choice.type === "none") {
      openai.tool_choice = "none";
    }
  }

  return openai;
}

function translateMessage(msg: any): any[] {
  const role = msg.role;

  // Simple string content — pass through
  if (typeof msg.content === "string") {
    return [{ role, content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role, content: "" }];
  }

  if (role === "assistant") return translateAssistantMessage(msg.content);
  if (role === "user") return translateUserMessage(msg.content);

  // Fallback: extract text
  const text = msg.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  return [{ role, content: text || "" }];
}

function translateAssistantMessage(blocks: any[]): any[] {
  const textParts: string[] = [];
  const toolCalls: any[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments:
            typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input || {}),
        },
      });
    }
    // "thinking" blocks are skipped — no OpenAI equivalent
  }

  const msg: any = {
    role: "assistant",
    content: textParts.join("\n") || null,
  };
  if (toolCalls.length) msg.tool_calls = toolCalls;

  return [msg];
}

function translateUserMessage(blocks: any[]): any[] {
  const result: any[] = [];
  const contentParts: any[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      contentParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      // Anthropic image → OpenAI image_url
      if (block.source?.type === "base64") {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
      } else if (block.source?.type === "url") {
        contentParts.push({
          type: "image_url",
          image_url: { url: block.source.url },
        });
      }
    } else if (block.type === "tool_result") {
      // Tool results must become separate role:"tool" messages in OpenAI format
      // Flush any accumulated content first
      if (contentParts.length) {
        result.push({
          role: "user",
          content: simplifyContent([...contentParts]),
        });
        contentParts.length = 0;
      }

      let toolContent = "";
      if (typeof block.content === "string") {
        toolContent = block.content;
      } else if (Array.isArray(block.content)) {
        toolContent = block.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }

      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: toolContent || "",
      });
    }
  }

  // Flush remaining content parts
  if (contentParts.length) {
    result.push({ role: "user", content: simplifyContent(contentParts) });
  }

  return result.length ? result : [{ role: "user", content: "" }];
}

/** If content is a single text part, simplify to a plain string */
function simplifyContent(parts: any[]): string | any[] {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

// ─── Response Translation (OpenAI → Anthropic) — Non-Streaming ─────────────

export function translateResponse(openai: any, originalModel: string): any {
  const choice = openai.choices?.[0];

  if (!choice) {
    return {
      id: `msg_${uid()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: originalModel,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: any[] = [];

  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        /* keep empty */
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}

// ─── Streaming Translation (OpenAI SSE → Anthropic SSE) ─────────────────────

export class StreamTranslator {
  private msgId: string;
  private model: string;
  private started = false;
  private textBlockActive = false;
  private textBlockIdx = -1;
  private nextBlockIdx = 0;
  /** Map: OpenAI tool_call index → Anthropic content block index */
  private toolMap = new Map<number, { blockIdx: number; id: string }>();
  private inputTokens = 0;
  private outputTokens = 0;
  private finished = false;

  constructor(model: string) {
    this.msgId = `msg_${uid()}`;
    this.model = model;
  }

  /**
   * Process one SSE data payload from the OpenAI stream.
   * Returns an array of Anthropic SSE event strings ready to be written.
   */
  processChunk(data: string): string[] {
    if (data === "[DONE]") return [];

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }

    const events: string[] = [];

    // ── Emit message_start on the very first chunk ──
    if (!this.started) {
      events.push(
        sse("message_start", {
          type: "message_start",
          message: {
            id: this.msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: this.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
        sse("ping", { type: "ping" })
      );
      this.started = true;
    }

    // Track usage (may arrive in any chunk or a dedicated usage-only chunk)
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta || {};

    // ── Text content ──
    if (delta.content != null && delta.content !== "") {
      if (!this.textBlockActive) {
        this.textBlockIdx = this.nextBlockIdx++;
        this.textBlockActive = true;
        events.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: this.textBlockIdx,
            content_block: { type: "text", text: "" },
          })
        );
      }
      events.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: this.textBlockIdx,
          delta: { type: "text_delta", text: delta.content },
        })
      );
    }

    // ── Tool calls ──
    if (delta.tool_calls) {
      // Close text block first (tools come after text in Anthropic format)
      if (this.textBlockActive) {
        events.push(
          sse("content_block_stop", {
            type: "content_block_stop",
            index: this.textBlockIdx,
          })
        );
        this.textBlockActive = false;
      }

      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index ?? 0;

        // New tool call — emit content_block_start
        if (tc.id && !this.toolMap.has(tcIdx)) {
          const blockIdx = this.nextBlockIdx++;
          this.toolMap.set(tcIdx, { blockIdx, id: tc.id });
          events.push(
            sse("content_block_start", {
              type: "content_block_start",
              index: blockIdx,
              content_block: {
                type: "tool_use",
                id: tc.id,
                name: tc.function?.name || "",
                input: {},
              },
            })
          );
        }

        // Argument delta → input_json_delta
        if (tc.function?.arguments) {
          const entry = this.toolMap.get(tcIdx);
          if (entry) {
            events.push(
              sse("content_block_delta", {
                type: "content_block_delta",
                index: entry.blockIdx,
                delta: {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                },
              })
            );
          }
        }
      }
    }

    // ── Finish ──
    if (choice.finish_reason && !this.finished) {
      this.finished = true;
      events.push(...this.emitFinish(choice.finish_reason));
    }

    return events;
  }

  private emitFinish(finishReason: string): string[] {
    const events: string[] = [];

    // Close any open text block
    if (this.textBlockActive) {
      events.push(
        sse("content_block_stop", {
          type: "content_block_stop",
          index: this.textBlockIdx,
        })
      );
      this.textBlockActive = false;
    }

    // Close all open tool blocks
    for (const [, entry] of this.toolMap) {
      events.push(
        sse("content_block_stop", {
          type: "content_block_stop",
          index: entry.blockIdx,
        })
      );
    }

    // If no blocks were ever opened, emit an empty text block
    if (this.nextBlockIdx === 0) {
      events.push(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sse("content_block_stop", {
          type: "content_block_stop",
          index: 0,
        })
      );
    }

    events.push(
      sse("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: this.outputTokens },
      }),
      sse("message_stop", { type: "message_stop" })
    );

    return events;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function uid(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}
