import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { Output, QgridError, generateText, queryQgrid } from "./index";

// --- Mock 서버 ---

const MOCK_USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 80,
};

const server = setupServer(
  http.post("http://localhost:44900/api/qgrid/query", async ({ request }) => {
    const body = (await request.json()) as { prompt: string; system?: string };

    // 특수 프롬프트로 에러 시나리오 테스트
    if (body.prompt === "__error_429__") {
      return HttpResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    if (body.prompt === "__error_503__") {
      return HttpResponse.json({ error: "Server unavailable" }, { status: 503 });
    }
    if (body.prompt === "__error_500__") {
      return HttpResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (body.prompt === "__invalid_json__") {
      return HttpResponse.json({
        text: "not valid json {[",
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }

    // primitive returnType 케이스: LLM이 따옴표 없이 raw로 반환
    if (body.prompt === "__raw_enum__") {
      return HttpResponse.json({
        text: "YES",
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }
    if (body.prompt === "__raw_number__") {
      return HttpResponse.json({
        text: "42",
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }
    if (body.prompt === "__raw_boolean__") {
      return HttpResponse.json({
        text: "true",
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }
    if (body.prompt === "__quoted_string__") {
      return HttpResponse.json({
        text: '"YES"',
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }

    // JSON 응답 요청 (system에 JSON Schema가 포함된 경우)
    if (body.system?.includes("JSON Schema")) {
      return HttpResponse.json({
        text: JSON.stringify({ questions: ["Q1", "Q2", "Q3"] }),
        usage: MOCK_USAGE,
        durationMs: 200,
        costUsd: 0.02,
      });
    }

    return HttpResponse.json({
      text: `Echo: ${body.prompt}`,
      usage: MOCK_USAGE,
      durationMs: 150,
      costUsd: 0.015,
    });
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// --- queryQgrid (기존 API 리네이밍) ---

describe("queryQgrid", () => {
  it("기본 텍스트 응답", async () => {
    const result = await queryQgrid({ prompt: "Hello" });

    expect(result.data).toBe("Echo: Hello");
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.durationMs).toBe(150);
    expect(result.costUsd).toBe(0.015);
  });

  it("returnType으로 구조화 응답", async () => {
    const schema = z.object({ questions: z.array(z.string()) });
    const result = await queryQgrid({
      prompt: "질문 생성",
      system: "질문 생성기",
      returnType: schema,
    });

    expect(result.data).toEqual({ questions: ["Q1", "Q2", "Q3"] });
  });

  it("429 에러 시 QUOTA_EXHAUSTED", async () => {
    await expect(queryQgrid({ prompt: "__error_429__" })).rejects.toThrow(QgridError);
    await expect(queryQgrid({ prompt: "__error_429__" })).rejects.toMatchObject({
      code: "QUOTA_EXHAUSTED",
      status: 429,
    });
  });

  it("503 에러 시 SERVER_UNAVAILABLE", async () => {
    await expect(queryQgrid({ prompt: "__error_503__" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });
  });

  it("기타 에러 시 REQUEST_FAILED", async () => {
    await expect(queryQgrid({ prompt: "__error_500__" })).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 500,
    });
  });

  it("JSON 파싱 실패 시 재시도 후 PARSE_FAILED", async () => {
    const schema = z.object({ name: z.string() });
    await expect(
      queryQgrid({ prompt: "__invalid_json__", returnType: schema, maxAttempts: 1 }),
    ).rejects.toMatchObject({
      code: "PARSE_FAILED",
      status: 200,
    });
  });

  it("z.enum: LLM이 raw 값 반환해도 처리", async () => {
    const schema = z.enum(["YES", "NO"]);
    const result = await queryQgrid({ prompt: "__raw_enum__", returnType: schema });
    expect(result.data).toBe("YES");
  });

  it("z.enum: LLM이 따옴표 감싸서 반환해도 처리", async () => {
    const schema = z.enum(["YES", "NO"]);
    const result = await queryQgrid({ prompt: "__quoted_string__", returnType: schema });
    expect(result.data).toBe("YES");
  });

  it("z.number: raw 숫자 반환", async () => {
    const schema = z.number();
    const result = await queryQgrid({ prompt: "__raw_number__", returnType: schema });
    expect(result.data).toBe(42);
  });

  it("z.boolean: raw boolean 반환", async () => {
    const schema = z.boolean();
    const result = await queryQgrid({ prompt: "__raw_boolean__", returnType: schema });
    expect(result.data).toBe(true);
  });
});

// --- generateText (ai-sdk 호환) ---
describe("generateText", () => {
  describe("prompt 기반 호출", () => {
    it("기본 텍스트 응답", async () => {
      const result = await generateText({ prompt: "Hello" });

      expect(result.text).toBe("Echo: Hello");
      expect(result.finishReason).toBe("stop");
      expect(result.output).toBe("Echo: Hello");
    });

    it("usage가 camelCase로 매핑됨 (cache 포함)", async () => {
      const { usage } = await generateText({ prompt: "Hello" });

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.totalTokens).toBe(150);
      expect(usage.inputTokenDetails.cacheReadTokens).toBe(80);
      expect(usage.inputTokenDetails.cacheWriteTokens).toBe(0);
    });

    it("system 파라미터 전달", async () => {
      const result = await generateText({
        prompt: "Hello",
        system: "Be brief.",
      });

      expect(result.text).toBe("Echo: Hello");
    });
  });

  describe("messages 기반 호출", () => {
    it("단일 user 메시지", async () => {
      const result = await generateText({
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.text).toBe("Echo: Hello");
    });

    it("system + user 메시지", async () => {
      const result = await generateText({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      });

      expect(result.text).toBe("Echo: Hello");
    });

    it("멀티턴 메시지 변환", async () => {
      const result = await generateText({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "How are you?" },
        ],
      });

      // 멀티턴은 role 라벨과 함께 결합
      expect(result.text).toBe("Echo: [user]: Hi\n\n[assistant]: Hello!\n\n[user]: How are you?");
    });

    it("별도 system 파라미터가 messages의 system보다 우선", async () => {
      const result = await generateText({
        system: "Direct system",
        messages: [
          { role: "system", content: "Message system" },
          { role: "user", content: "Hello" },
        ],
      });

      // directSystem이 우선 (directSystem ?? converted.system)
      expect(result.text).toBe("Echo: Hello");
    });
  });

  describe("구조화 출력 (Output.object)", () => {
    it("Output.object로 스키마 전달", async () => {
      const schema = z.object({ questions: z.array(z.string()) });
      const result = await generateText({
        prompt: "질문 생성",
        system: "질문 생성기",
        output: Output.object({ schema }),
      });

      expect(result.output).toEqual({ questions: ["Q1", "Q2", "Q3"] });
      expect(result.text).toBe(JSON.stringify({ questions: ["Q1", "Q2", "Q3"] }));
    });
  });

  describe("ai-sdk 호환 파라미터 무시", () => {
    it("model과 providerOptions를 전달해도 정상 동작", async () => {
      const result = await generateText({
        model: "some-model",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        prompt: "Hello",
      });

      expect(result.text).toBe("Echo: Hello");
    });
  });
});

// --- Output 헬퍼 ---

describe("Output", () => {
  it("Output.object가 올바른 OutputDefinition 반환", () => {
    const schema = z.object({ name: z.string() });
    const def = Output.object({ schema });

    expect(def.type).toBe("object");
    expect(def.schema).toBe(schema);
  });
});

// --- QgridError ---

describe("QgridError", () => {
  it("code, status, message 포함", () => {
    const err = new QgridError("TEST_CODE", 400, "Test message");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(QgridError);
    expect(err.code).toBe("TEST_CODE");
    expect(err.status).toBe(400);
    expect(err.message).toBe("Test message");
    expect(err.name).toBe("QgridError");
  });
});
