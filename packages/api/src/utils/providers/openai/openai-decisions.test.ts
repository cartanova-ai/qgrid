import { describe, expect, it, vi } from "vitest";

import { OpenAIDecisionRequest } from "../../../application/qgrid/qgrid.types";
import {
  createOpenAIDecision,
  fromOpenAIDecisionResult,
  toOpenAIDecisionRequest,
} from "./openai-decisions";

const credentials = { accessToken: "subscription-token", accountId: "account" };

const request = {
  model: "gpt-6-luna" as const,
  input: "An apple is a fruit.",
  questions: [
    {
      type: "choice" as const,
      name: "category",
      instructions: "Classify the object.",
      choices: [{ value: "fruit" }, { value: "vehicle" }],
    },
  ],
};

const answer = {
  model: "gpt-6-luna",
  answers: [
    {
      type: "choice",
      name: "category",
      choice: "fruit",
      probabilities: [
        { value: "fruit", probability: 1 },
        { value: "vehicle", probability: 0 },
      ],
      confidence: 1,
    },
  ],
  usage: {
    input_tokens: 115,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
    output_tokens: 0,
  },
};

describe("createOpenAIDecision", () => {
  it("calls the public endpoint with the OAuth token and returns typed answers", async () => {
    const fetcher = vi.fn(async () => Response.json(answer));
    const result = await createOpenAIDecision(credentials, request, undefined, fetcher);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer subscription-token");
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(result).toEqual(answer);
  });

  it("rejects requests outside API limits before sending", () => {
    const [question] = request.questions;

    expect(() =>
      OpenAIDecisionRequest.parse({ ...request, questions: [question, question] }),
    ).toThrow();
    expect(() =>
      OpenAIDecisionRequest.parse({
        ...request,
        questions: [{ ...question, choices: [{ value: "only" }] }],
      }),
    ).toThrow();
    expect(() =>
      OpenAIDecisionRequest.parse({
        ...request,
        questions: [{ ...question, instructions: "" }],
      }),
    ).toThrow("requires instructions");
  });

  it("maps HTTP errors to OpenAIProtocolError with status for the dispatcher's 401 refresh", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { message: "Token expired", code: "invalid_token" } }, { status: 401 }),
    );

    await expect(
      createOpenAIDecision(credentials, request, undefined, fetcher),
    ).rejects.toMatchObject({
      name: "OpenAIProtocolError",
      status: 401,
      code: "invalid_token",
      message: "Token expired",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a response missing an answer", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...answer, answers: [] }));

    await expect(createOpenAIDecision(credentials, request, undefined, fetcher)).rejects.toThrow(
      "exactly one answer per question",
    );
  });
});

describe("qgrid neutral shape <-> OpenAI wire", () => {
  it("maps state parts, question IDs, and criteria as @ai-sdk/openai does", () => {
    const wire = toOpenAIDecisionRequest({
      model: "openai/gpt-6-luna",
      state: [
        { type: "text", text: "ticket" },
        { type: "json", value: { orderId: 7 } },
        { type: "json", value: [1, 2] },
        { type: "image", url: "https://example.com/a.png" },
      ],
      questions: {
        severity: { type: "score", criteria: ["Cosmetic", null] },
        refund: { type: "boolean", criteria: { true: "asks for money back", false: { kind: "other" } } },
      },
    });

    expect(wire.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "ticket" },
          { type: "input_json", data: { orderId: 7 } },
          { type: "input_text", text: "[1,2]" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      },
    ]);
    expect(wire.questions).toEqual([
      {
        type: "score",
        name: "severity",
        instructions: "",
        levels: [{ label: "0", description: "Cosmetic" }, { label: "1" }],
      },
      {
        type: "predicate",
        name: "refund",
        instructions: 'Criteria for true:\nasks for money back\n\nCriteria for false:\n{"kind":"other"}',
      },
    ]);
  });

  it("returns answers keyed by question ID and rejects a mismatched answer type", () => {
    const questions = {
      severity: { type: "score" as const, criteria: ["low", "high"] },
      refund: { type: "boolean" as const, instructions: "Refund?" },
    };

    const neutral = fromOpenAIDecisionResult(questions, {
      model: "gpt-6-luna",
      answers: [
        {
          type: "score",
          name: "severity",
          score: 0.3,
          probabilities: [
            { value: 0, probability: 0.7 },
            { value: 1, probability: 0.3 },
          ],
          confidence: null,
        },
        { type: "refusal", name: "refund" },
      ],
    });

    expect(neutral.answers).toEqual({
      severity: { type: "score", score: 0.3, probabilities: { "0": 0.7, "1": 0.3 } },
      refund: { type: "refusal" },
    });
    expect(() =>
      fromOpenAIDecisionResult(questions, {
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "severity", probability: 1 },
          { type: "predicate", name: "refund", probability: 1 },
        ],
      }),
    ).toThrow("answered a score question with predicate");
  });
});
