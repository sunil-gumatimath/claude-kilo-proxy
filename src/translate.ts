// ============================================================================
// translate.ts — Anthropic Messages API ↔ OpenAI Chat Completions translator
// ============================================================================

import type {
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
} from "./types";

// ─── Request Translation (Anthropic → OpenAI) ──────────────────────────────

export function translateRequest(
  body: AnthropicMessagesRequest,
  modelPrefix: string,
  defaultModel = "claude-sonnet-4-20250514"
): OpenAIChatRequest {
  const openai: OpenAIChatRequest = {
    model: "",
    messages: [],
  };

  const model = body.model || defaultModel;
  openai.model =
    modelPrefix && model.startsWith(modelPrefix)
      ? model
      : modelPrefix + model;

  const messages: OpenAIMessage[] = [];

  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  for (const msg of body.messages || []) {
    messages.push(...translateMessage(msg));
  }
  openai.messages = messages;

  if (body.max_tokens != null) openai.max_tokens = body.max_tokens;
  if (body.temperature != null) openai.temperature = body.temperature;
  if (body.top_p != null) openai.top_p = body.top_p;
  if (body.stop_sequences) openai.stop = body.stop_sequences;
  if (body.stream != null) openai.stream = body.stream;

  if (body.stream) {
    openai.stream_options = { include_usage: true };
  }

  if (body.tools?.length) {
    openai.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }

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

function translateMessage(msg: {
  role: string;
  content: string | AnthropicContentBlock[];
}): OpenAIMessage[] {
  const role = msg.role;

  if (typeof msg.content === "string") {
    return [{ role, content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role, content: "" }];
  }

  if (role === "assistant") return translateAssistantMessage(msg.content);
  if (role === "user") return translateUserMessage(msg.content);

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? String(b.text) : ""))
    .join("\n");
  return [{ role, content: text || "" }];
}

function translateAssistantMessage(
  blocks: AnthropicContentBlock[]
): OpenAIMessage[] {
  const textParts: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

  for (const block of blocks) {
    if (block.type === "text" && "text" in block) {
      textParts.push(String(block.text));
    } else if (block.type === "tool_use" && "id" in block && "name" in block) {
      const input = "input" in block ? block.input : {};
      toolCalls.push({
        id: String(block.id),
        type: "function",
        function: {
          name: String(block.name),
          arguments:
            typeof input === "string" ? input : JSON.stringify(input ?? {}),
        },
      });
    }
    // "thinking" blocks — no OpenAI equivalent; skipped intentionally
  }

  const out: OpenAIMessage = {
    role: "assistant",
    content: textParts.join("\n") || null,
  };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return [out];
}

function translateUserMessage(
  blocks: AnthropicContentBlock[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  const contentParts: unknown[] = [];

  for (const block of blocks) {
    if (block.type === "text" && "text" in block) {
      contentParts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && "source" in block) {
      const source = block.source as {
        type?: string;
        media_type?: string;
        data?: string;
        url?: string;
      };
      if (source?.type === "base64" && source.media_type && source.data) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${source.media_type};base64,${source.data}`,
          },
        });
      } else if (source?.type === "url" && source.url) {
        contentParts.push({
          type: "image_url",
          image_url: { url: source.url },
        });
      }
    } else if (block.type === "tool_result" && "tool_use_id" in block) {
      if (contentParts.length) {
        result.push({
          role: "user",
          content: simplifyContent([...contentParts]),
        });
        contentParts.length = 0;
      }

      let toolContent = "";
      const content = "content" in block ? block.content : undefined;
      if (typeof content === "string") {
        toolContent = content;
      } else if (Array.isArray(content)) {
        toolContent = content
          .filter((b) => b && typeof b === "object" && "type" in b && b.type === "text")
          .map((b) => ("text" in b ? String(b.text) : ""))
          .join("\n");
      }

      const toolMsg: OpenAIMessage = {
        role: "tool",
        tool_call_id: String(block.tool_use_id),
        content: toolContent || "",
      };
      // Some gateways accept this for failed tools
      if ("is_error" in block && block.is_error) {
        (toolMsg as OpenAIMessage & { is_error?: boolean }).is_error = true;
      }
      result.push(toolMsg);
    }
  }

  if (contentParts.length) {
    result.push({ role: "user", content: simplifyContent(contentParts) });
  }

  return result.length ? result : [{ role: "user", content: "" }];
}

function simplifyContent(parts: unknown[]): string | unknown[] {
  if (
    parts.length === 1 &&
    parts[0] &&
    typeof parts[0] === "object" &&
    (parts[0] as { type?: string }).type === "text"
  ) {
    return String((parts[0] as { text: string }).text);
  }
  return parts;
}

// ─── Response Translation (OpenAI → Anthropic) — Non-Streaming ─────────────

export function translateResponse(
  openai: OpenAIChatResponse,
  originalModel: string
): AnthropicMessageResponse {
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

  const content: AnthropicContentBlock[] = [];

  if (choice.message?.content) {
    content.push({ type: "text", text: String(choice.message.content) });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { raw: tc.function.arguments };
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
    id: openai.id ? `msg_${openai.id.replace(/^chatcmpl-/, "")}` : `msg_${uid()}`,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason: mapFinishReason(choice.finish_reason ?? null),
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
  /** OpenAI tool_call index → Anthropic content block index */
  private toolMap = new Map<
    number,
    { blockIdx: number; id: string; name: string; pendingArgs: string }
  >();
  private inputTokens = 0;
  private outputTokens = 0;
  private finished = false;

  constructor(model: string) {
    this.msgId = `msg_${uid()}`;
    this.model = model;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Process one SSE data payload from the OpenAI stream.
   * Returns Anthropic SSE event strings ready to write.
   */
  processChunk(data: string): string[] {
    if (data === "[DONE]") {
      return this.finalize("stop");
    }

    let chunk: OpenAIChatResponse & {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    try {
      chunk = JSON.parse(data);
    } catch {
      return [];
    }

    const events: string[] = [];

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

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta || {};

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

    if (delta.tool_calls) {
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
        let entry = this.toolMap.get(tcIdx);

        // Open block when we first see this index (id may arrive later)
        if (!entry) {
          const id = tc.id || `toolu_${uid()}`;
          const name = tc.function?.name || "";
          const blockIdx = this.nextBlockIdx++;
          entry = { blockIdx, id, name, pendingArgs: "" };
          this.toolMap.set(tcIdx, entry);
          events.push(
            sse("content_block_start", {
              type: "content_block_start",
              index: blockIdx,
              content_block: {
                type: "tool_use",
                id,
                name,
                input: {},
              },
            })
          );
        } else {
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
        }

        if (tc.function?.arguments) {
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

    if (choice.finish_reason && !this.finished) {
      events.push(...this.emitFinish(choice.finish_reason));
    }

    return events;
  }

  /**
   * Ensure stream always ends with Anthropic close events
   * (e.g. upstream closed without finish_reason).
   */
  finalize(reason = "stop"): string[] {
    if (this.finished) return [];
    if (!this.started) {
      // Empty stream — still emit a minimal valid message
      this.started = true;
      return [
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
        ...this.emitFinish(reason),
      ];
    }
    return this.emitFinish(reason);
  }

  private emitFinish(finishReason: string): string[] {
    if (this.finished) return [];
    this.finished = true;
    const events: string[] = [];

    if (this.textBlockActive) {
      events.push(
        sse("content_block_stop", {
          type: "content_block_stop",
          index: this.textBlockIdx,
        })
      );
      this.textBlockActive = false;
    }

    for (const [, entry] of this.toolMap) {
      events.push(
        sse("content_block_stop", {
          type: "content_block_stop",
          index: entry.blockIdx,
        })
      );
    }

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
        usage: {
          output_tokens: this.outputTokens,
          input_tokens: this.inputTokens,
        },
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

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function uid(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  } catch {
    return (
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10)
    );
  }
}
