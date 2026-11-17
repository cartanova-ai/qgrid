import { describe, expect, it } from "vitest";

import {
  ChatCompletionRequest,
  ChatCompletionRequestError,
  toChatCompletion,
  toQueryInput,
} from "./openai-compat";
import { type QueryOutput } from "./qgrid.types";

const parse = (body: object) => ChatCompletionRequest.parse(body);

describe("toQueryInput", () => {
  it("maps system and the last user message, ignoring sampling options", () => {
    const input = toQueryInput(parse({
      model: "openai/gpt-5.4",
      messages: [
        { role: "system", content: "summarize" },
        { role: "user", content: "transcript" },
      ],
      temperature: 0.3,
      max_tokens: 10,
    }));

    expect(input).toEqual({
      model: "openai/gpt-5.4",
      system: "summarize",
      prompt: "transcript",
      projectName: "openai-compat",
    });
  });

  it("replays earlier turns as Responses-style history and joins text parts", () => {
    const input = toQueryInput(
      parse({
        model: "openai/m",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: [{ type: "text", text: "c" }, { type: "text", text: "d" }] },
        ],
      }),
      "meetily",
    );

    expect(input.prompt).toBe("cd");
    expect(input.projectName).toBe("meetily");
    expect(JSON.parse(input.history ?? "")).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
    ]);
  });

  it.each([
    ["stream", { stream: true }],
    ["tools", { tools: [{ type: "function" }] }],
    ["tool messages", { messages: [{ role: "tool", content: "x" }] }],
    ["trailing assistant", { messages: [{ role: "assistant", content: "x" }] }],
  ])("rejects %s", (_name, overrides) => {
    const body = parse({ model: "openai/m", messages: [{ role: "user", content: "hi" }], ...overrides });

    expect(() => toQueryInput(body)).toThrow(ChatCompletionRequestError);
  });

  it.each([
    ["image parts", { messages: [{ role: "user", content: [{ type: "image_url" }] }] }],
    ["empty model", { model: "" }],
    ["prefix-less model", { model: "claude-opus-5-5" }],
  ])("schema rejects %s", (_name, overrides) => {
    const body = { model: "openai/m", messages: [{ role: "user", content: "hi" }], ...overrides };

    expect(ChatCompletionRequest.safeParse(body).success).toBe(false);
  });
});

describe("toChatCompletion", () => {
  it("wraps text and folds cached input into prompt_tokens", () => {
    const result = {
      requestLogId: 42,
      text: "summary",
      model: "openai/gpt-5.4",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
    } as QueryOutput;

    expect(toChatCompletion(result, "requested")).toMatchObject({
      id: "chatcmpl-42",
      object: "chat.completion",
      model: "openai/gpt-5.4",
      choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    });
  });
});
