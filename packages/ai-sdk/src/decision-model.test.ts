import { experimental_decide as decide, Experimental_DecisionRefusalError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

const usage = { inputTokens: 300, outputTokens: 0, cachedInputTokens: 100, cacheWriteTokens: 0 };

function mockDecide(answers: object) {
  const fetchMock = vi.fn(async () =>
    Response.json({ model: "openai/gpt-6-luna", answers, usage, tokenName: "openai/main", requestLogId: 9 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const questions = {
  department: { type: "choice", criteria: { billing: "Payments", support: "Other", sales: null } },
  severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] },
  refund: { type: "boolean", instructions: "Asks for money back?" },
} as const;

describe("qgrid.decision with AI SDK experimental_decide", () => {
  it("sends the neutral request and returns AI SDK answers with qgrid metadata", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    vi.stubEnv("QGRID_PROJECT_NAME", "routing");
    // Two-decimal probabilities summing to 0.99 and a rounded score pass via the rounding declaration.
    const fetchMock = mockDecide({
      department: { type: "choice", choice: "billing", probabilities: { billing: 0.33, support: 0.33, sales: 0.33 }, confidence: 0.4 },
      severity: { type: "score", score: 0.67, probabilities: { "0": 0.33, "1": 0.67 } },
      refund: { type: "boolean", probability: 0.92 },
    });

    const result = await decide({
      model: qgrid.decision("openai/gpt-6-luna"),
      state: [
        { type: "text", text: "charged twice" },
        { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      ],
      questions,
      providerOptions: { openai: { promptCacheKey: "k", store: true }, qgrid: { tokenName: "openai/main" } },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qgrid.example/api/qgrid/decide");
    expect(JSON.parse(String(init.body)).params).toEqual({
      model: "openai/gpt-6-luna",
      state: [
        { type: "text", text: "charged twice" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
      questions: {
        department: { type: "choice", instructions: null, criteria: { billing: "Payments", support: "Other", sales: null } },
        severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] },
        refund: { type: "boolean", instructions: "Asks for money back?", criteria: null },
      },
      promptCacheKey: "k",
      projectName: "routing",
      tokenName: "openai/main",
    });
    expect(result.answers.department).toEqual({ type: "choice", choice: "billing", probabilities: { billing: 0.33, support: 0.33, sales: 0.33 } });
    expect(result.answers.severity.score).toBe(0.67);
    expect(result.answers.refund.probability).toBe(0.92);
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 0 });
    expect(result.providerMetadata?.qgrid).toEqual({
      tokenName: "openai/main",
      requestLogId: 9,
      confidence: { department: 0.4 },
      cachedInputTokens: 100,
      cacheWriteTokens: 0,
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ feature: "providerOptions.openai.store" }));
  });

  it("surfaces a refused question as AI SDK's refusal error", async () => {
    mockDecide({
      department: { type: "refusal" },
      severity: { type: "score", score: 1, probabilities: { "0": 0, "1": 1 } },
      refund: { type: "boolean", probability: 0.1 },
    });

    await expect(
      decide({ model: qgrid.decision("openai/gpt-6-luna"), state: "x", questions, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(Experimental_DecisionRefusalError);
  });

  it("rejects unsupported models and non-image files before any request", async () => {
    const fetchMock = mockDecide({});

    expect(() => qgrid.decision("openai/gpt-6-sol" as "openai/gpt-6-luna")).toThrow("unsupported model");
    await expect(
      decide({
        model: qgrid.decision("openai/gpt-6-luna"),
        state: [{ type: "file", mediaType: "application/pdf", data: new Uint8Array([1]) }],
        questions,
        maxRetries: 0,
      }),
    ).rejects.toThrow("file input: application/pdf");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
