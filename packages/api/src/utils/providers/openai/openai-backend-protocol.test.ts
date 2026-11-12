import { describe, expect, it } from "vitest";

import {
  buildCodexIdentityHeaders,
  buildOpenAIResponsesRequest,
  codexCliUserAgent,
  imageMimeType,
  normalizeOpenAIEvent,
} from "./openai-backend-protocol";

describe("OpenAI Codex backend protocol", () => {
  it("distinguishes partial function items from completed arguments", () => {
    const item = { type: "function_call", call_id: "call", name: "generate_image", arguments: "{}" };
    expect(normalizeOpenAIEvent({ type: "response.output_item.added", item })).toEqual({ type: "output-item", item, completed: false });
    expect(normalizeOpenAIEvent({ type: "response.output_item.done", item })).toEqual({ type: "output-item", item, completed: true });
  });
  it.each([
    ["iVBORw0KGgo=", "jpeg", "image/png"],
    ["UklGRgAAAABXRUJQ", "png", "image/webp"],
    ["/9j/", undefined, "image/jpeg"],
    ["aGVsbG8=", "webp", "image/webp"],
  ])("detects history image MIME from bytes before the format label: %s", (base64, format, mimeType) => {
    expect(imageMimeType(base64, format)).toBe(mimeType);
  });

  it("preserves raw history and pins Responses controls", () => {
    const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5.2-codex",
      history,
      reasoning: { effort: "high", summary: "auto" },
      verbosity: "low",
      serviceTier: "priority",
      promptCacheKey: "thread-1",
      outputSchema: { schema: { type: "object", additionalProperties: false } },
    });

    expect(request).toEqual({
      model: "gpt-5.2-codex",
      input: history,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      service_tier: "priority",
      prompt_cache_key: "thread-1",
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          strict: true,
          schema: { type: "object", additionalProperties: false },
          name: "codex_output_schema",
        },
      },
    });
    expect(request.input[0]).toBe(history[0]);
  });

  it("matches the pinned Codex user-agent shape with injected platform data", () => {
    expect(
      codexCliUserAgent({
        osType: "Mac OS",
        osVersion: "15.4.1",
        architecture: "arm64",
        terminal: "vscode/1.99.0",
      }),
    ).toBe("codex_cli_rs/0.147.0 (Mac OS 15.4.1; arm64) vscode/1.99.0");
  });

  it("builds ChatGPT and Codex CLI identity headers", () => {
    const headers = buildCodexIdentityHeaders("token", "acct", {
      sessionId: "session",
      threadId: "thread",
      clientRequestId: "request",
    });
    expect(headers).toEqual({
      Accept: "text/event-stream",
      Authorization: "Bearer token",
      "ChatGPT-Account-ID": "acct",
      "Content-Type": "application/json",
      originator: "codex_cli_rs",
      "User-Agent": expect.stringMatching(/^codex_cli_rs\/0\.147\.0 \(.+; .+\) .+$/),
      "session-id": "session",
      "thread-id": "thread",
      "x-client-request-id": "request",
    });
  });

  it("normalizes usage", () => {
    expect(
      normalizeOpenAIEvent({
        type: "response.completed",
        response: {
          id: "r1",
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 7,
          },
        },
      }),
    ).toEqual({
      type: "completed",
      responseId: "r1",
      usage: { inputTokens: 4, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1, totalTokens: 7 },
    });
  });
});
