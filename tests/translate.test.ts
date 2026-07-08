import { describe, expect, test } from "bun:test";
import {
  StreamTranslator,
  translateRequest,
  translateResponse,
} from "../src/translate";

describe("translateRequest", () => {
  test("prefixes model name", () => {
    const out = translateRequest(
      {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      "anthropic/"
    );
    expect(out.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(out.max_tokens).toBe(100);
  });

  test("does not double-prefix model", () => {
    const out = translateRequest(
      {
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hi" }],
      },
      "anthropic/"
    );
    expect(out.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("maps system string and tools", () => {
    const out = translateRequest(
      {
        model: "m",
        system: "You are helpful",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "get_weather",
            description: "Weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
        tool_choice: { type: "auto" },
        stream: true,
      },
      "anthropic/"
    );
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are helpful",
    });
    expect(out.tools).toHaveLength(1);
    expect((out.tools as any)[0].function.name).toBe("get_weather");
    expect(out.tool_choice).toBe("auto");
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  test("maps tool_result to role:tool messages", () => {
    const out = translateRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: "ok",
              },
            ],
          },
        ],
      },
      ""
    );
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });

  test("maps assistant tool_use to tool_calls", () => {
    const out = translateRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Using tool" },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "search",
                input: { q: "bun" },
              },
            ],
          },
        ],
      },
      ""
    );
    expect(out.messages[0].content).toBe("Using tool");
    expect(out.messages[0].tool_calls?.[0]).toMatchObject({
      id: "toolu_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"bun"}' },
    });
  });
});

describe("translateResponse", () => {
  test("maps text + finish_reason", () => {
    const out = translateResponse(
      {
        choices: [
          {
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      "claude-test"
    );
    expect(out.model).toBe("claude-test");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  test("maps tool_calls finish to tool_use", () => {
    const out = translateResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m"
    );
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[0]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "NYC" },
    });
  });
});

describe("StreamTranslator", () => {
  test("translates text stream and finishes", () => {
    const t = new StreamTranslator("claude-test");
    const events = [
      ...t.processChunk(
        JSON.stringify({
          choices: [{ delta: { content: "Hi" }, index: 0 }],
        })
      ),
      ...t.processChunk(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      ),
    ];
    const joined = events.join("");
    expect(joined).toContain("message_start");
    expect(joined).toContain("text_delta");
    expect(joined).toContain("Hi");
    expect(joined).toContain("message_stop");
    expect(joined).toContain("end_turn");
    expect(t.isFinished).toBe(true);
  });

  test("finalize closes stream without finish_reason", () => {
    const t = new StreamTranslator("m");
    t.processChunk(
      JSON.stringify({
        choices: [{ delta: { content: "x" }, index: 0 }],
      })
    );
    const end = t.finalize("stop");
    const joined = end.join("");
    expect(joined).toContain("message_stop");
    expect(t.finalize("stop")).toEqual([]); // idempotent
  });

  test("tool call args before id still emit deltas", () => {
    const t = new StreamTranslator("m");
    const e1 = t.processChunk(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"a":' } },
              ],
            },
          },
        ],
      })
    );
    const e2 = t.processChunk(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  function: { name: "fn", arguments: "1}" },
                },
              ],
            },
          },
        ],
      })
    );
    const joined = [...e1, ...e2].join("");
    expect(joined).toContain("content_block_start");
    expect(joined).toContain("input_json_delta");
    // Payload is JSON-stringified inside SSE (quotes escaped)
    expect(joined).toContain("partial_json");
    expect(joined.includes("{") && joined.includes("a")).toBe(true);
  });
});
