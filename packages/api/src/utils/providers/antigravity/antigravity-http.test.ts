import { describe, expect, it, vi } from "vitest";

import { antigravityUsage, buildAntigravityRequest, checkedJson, generateAntigravityHttp } from "./antigravity-http";

const credentials = { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: 9e15, accountId: "account-a", accountEmail: "a@example.test", projectId: "project-a" };
const req = { model: "gemini-3.1-flash-lite", coldInput: [{ type: "text" as const, text: "hello", text_elements: [] }] };
const event = (text: string, finish = false) => ({ response: {
  candidates: [{ content: { parts: [{ text }] }, ...(finish ? { finishReason: "STOP" } : {}) }],
  ...(finish ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 15 } } : {}),
} });

describe("Antigravity direct HTTP", () => {
  it.each([false, true])("returns integer millisecond timings for DB logging (stream=%s)", async (stream) => {
    const data = event("ok", true);
    const response = new Response(stream ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data));
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValue(4588.280417000002);
    try {
      const result = await generateAntigravityHttp(req, credentials, req.model, stream ? vi.fn() : undefined, { fetch: vi.fn().mockResolvedValue(response) });
      expect(result.durationMs).toBe(3588);
      expect(result.ttftMs).toBe(3588);
    } finally {
      clock.mockRestore();
    }
  });
  it("uses the selected account and no credit/tool fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(event("ok", true))));
    const result = await generateAntigravityHttp(req, credentials, req.model, undefined, { fetch: fetchMock });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("v1internal:generateContent");
    expect(init.headers.Authorization).toBe("Bearer test-access");
    const body = JSON.parse(init.body);
    expect(body.project).toBe("project-a");
    expect(body.request.contents[0].parts).toEqual([{ text: "hello" }]);
    expect(body.allowedCreditTypes).toBeUndefined();
    expect(body.request.tools).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(result.usage.outputTokens).toBe(5);
  });

  it("preserves caller system and full text history", () => {
    const body = buildAntigravityRequest({ ...req, systemPrompt: "caller system", coldHistory: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier" }] }] }, "project", req.model);
    expect(body.request.systemInstruction?.parts[0]?.text).toBe("caller system");
    expect(body.request.contents[0]?.parts[0]?.text).toContain("earlier");
  });

  it("parses split UTF-8 SSE and omits reasoning text", async () => {
    const thought = { response: { candidates: [{ content: { parts: [{ thought: true, text: "private reasoning" }] } }] } };
    const bytes = new TextEncoder().encode([thought, event("안녕"), event("!", true)].map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
    const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const onDelta = vi.fn();
    const result = await generateAntigravityHttp(req, credentials, req.model, onDelta, { fetch: vi.fn().mockResolvedValue(new Response(body)) });
    expect(result.text).toBe("안녕!");
    expect(onDelta.mock.calls.flat()).toEqual(["안녕", "!"]);
  });

  it("does not count cached input twice", () => {
    expect(antigravityUsage({ promptTokenCount: 100, cachedContentTokenCount: 80 }).inputTokens).toBe(100);
  });

  it.each(["MAX_TOKENS", "SAFETY"])("rejects incomplete finish %s", async (finishReason) => {
    const body = { response: { candidates: [{ finishReason }] } };
    await expect(generateAntigravityHttp(req, credentials, req.model, undefined, { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) })).rejects.toThrow(finishReason);
  });

  it("rejects a truncated stream", async () => {
    await expect(generateAntigravityHttp(req, credentials, req.model, vi.fn(), { fetch: vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(event("partial"))}\n\n`)) })).rejects.toThrow("without a successful finish");
  });

  it("does not put raw provider error text into logs/UI errors", async () => {
    await expect(checkedJson(new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "sensitive-account-details" } }), { status: 403 }))).rejects.toThrow("Antigravity HTTP 403 (PERMISSION_DENIED)");
  });
});
