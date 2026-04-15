import { type generateText as _aiGenerateText } from "ai";
import { z } from "zod";

import { type OutputDefinition } from "./output";
import { type QgridResponse, type QgridTypedResponse, type QgridUsage } from "./types";

type AiGenerateTextParams = Parameters<typeof _aiGenerateText>[0];
type AiGenerateTextResult = Awaited<ReturnType<typeof _aiGenerateText>>;

export class QgridError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "QgridError";
  }
}

const jsonSchemaCache = new WeakMap<z.ZodType, string>();
function getJsonSchemaString(schema: z.ZodType): string {
  let cached = jsonSchemaCache.get(schema);
  if (!cached) {
    cached = JSON.stringify(z.toJSONSchema(schema));
    jsonSchemaCache.set(schema, cached);
  }
  return cached;
}

/**
 * 기존 qgrid 전용 API.
 * 단순한 prompt/system 기반 호출 + Zod returnType 검증.
 */
export async function queryQgrid<T extends z.ZodType | undefined = undefined>(params: {
  prompt: string;
  system?: string;
  returnType?: T;
  timeout?: number;
  serverUrl?: string;
  maxAttempts?: number;
}): Promise<T extends z.ZodType ? QgridTypedResponse<z.infer<T>> : QgridResponse> {
  const { prompt, system, returnType } = params;
  const url = params.serverUrl ?? process.env.QGRID_URL ?? "http://localhost:44900";
  const timeout = params.timeout ?? 300_000;
  const maxAttempts = params.maxAttempts ?? 3;

  const systemWithSchema = returnType
    ? `${system ?? ""}\n\n반드시 다음 JSON Schema에 맞게 JSON으로만 응답하세요. 다른 텍스트 없이:\n${getJsonSchemaString(returnType)}`
    : system;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${url}/api/qgrid/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, system: systemWithSchema }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const message = err.error ?? err.message ?? res.statusText;
      if (res.status === 429) throw new QgridError("QUOTA_EXHAUSTED", 429, message);
      if (res.status === 503) throw new QgridError("SERVER_UNAVAILABLE", 503, message);
      throw new QgridError("REQUEST_FAILED", res.status, message);
    }

    const { text, ...rest } = await res.json();
    if (!returnType) {
      return { ...rest, data: text } as any;
    }

    try {
      return { ...rest, data: z.parse(returnType, JSON.parse(text)) } as any;
    } catch (e) {
      lastError = e as Error;
      if (attempt < maxAttempts) {
        console.warn(`[qgrid] JSON 파싱 실패 (attempt ${attempt}/${maxAttempts}), 재시도...`);
      }
    }
  }

  throw new QgridError(
    "PARSE_FAILED",
    200,
    `JSON 파싱/검증 실패 (${maxAttempts}회 시도): ${lastError?.message}`,
  );
}

// --- ai-sdk 호환 API ---

function extractPromptAndSystem(params: Record<string, any>): { prompt: string; system?: string } {
  let system: string | undefined;

  if (params.system) {
    system = typeof params.system === "string" ? params.system : JSON.stringify(params.system);
  }

  if ("prompt" in params && params.prompt) {
    const p = params.prompt;
    return { prompt: typeof p === "string" ? p : JSON.stringify(p), system };
  }

  if ("messages" in params && params.messages) {
    const messages = params.messages as Array<{ role: string; content: unknown }>;
    const systemMsgs = messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");
    if (!system && systemMsgs.length > 0) {
      system = systemMsgs.join("\n");
    }

    if (nonSystemMsgs.length === 1 && nonSystemMsgs[0].role === "user") {
      const content = nonSystemMsgs[0].content;
      return { prompt: typeof content === "string" ? content : JSON.stringify(content), system };
    }

    const prompt = nonSystemMsgs
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${m.role}]: ${content}`;
      })
      .join("\n\n");
    return { prompt, system };
  }

  throw new QgridError("INVALID_INPUT", 400, "prompt 또는 messages 중 하나는 필수입니다.");
}

function mapUsage(usage: QgridUsage): AiGenerateTextResult["usage"] {
  return {
    inputTokens: usage.input_tokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
    },
    outputTokens: usage.output_tokens,
    outputTokenDetails: {
      textTokens: usage.output_tokens,
      reasoningTokens: undefined,
    },
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function extractSchema(output: unknown): z.ZodType | undefined {
  if (!output || typeof output !== "object") return undefined;
  if (!("type" in output) || !("schema" in output)) return undefined;
  const def = output as OutputDefinition<unknown>;
  if (def.type === "text" || !def.schema) return undefined;
  return def.schema as z.ZodType;
}

type BaseParams = Omit<AiGenerateTextParams, "model" | "output" | "experimental_output"> & {
  model?: AiGenerateTextParams["model"];
  serverUrl?: string;
  maxAttempts?: number;
};

type GenerateTextResponse<T> = {
  text: string;
  usage: AiGenerateTextResult["usage"];
  finishReason: AiGenerateTextResult["finishReason"];
  output: T;
};

// OutputDefinition → T 추론
export async function generateText<T>(
  params: BaseParams & { output: OutputDefinition<T> },
): Promise<GenerateTextResponse<T>>;

// output 없음 → string
export async function generateText(params: BaseParams): Promise<GenerateTextResponse<string>>;

// implementation
export async function generateText(
  params: BaseParams & { output?: OutputDefinition<any> },
): Promise<GenerateTextResponse<any>> {
  const { prompt, system } = extractPromptAndSystem(params);
  const schema = extractSchema(params.output);
  const rest = { serverUrl: params.serverUrl, maxAttempts: params.maxAttempts };

  if (schema) {
    const result = await queryQgrid({ prompt, system, returnType: schema, ...rest });
    return {
      text: JSON.stringify(result.data),
      usage: mapUsage(result.usage),
      finishReason: "stop",
      output: result.data,
    };
  }

  const result = await queryQgrid({ prompt, system, ...rest });
  return {
    text: result.data,
    usage: mapUsage(result.usage),
    finishReason: "stop",
    output: result.data,
  };
}

export { Output } from "./output";
export type { OutputDefinition } from "./output";
export type { QgridBase, QgridResponse, QgridTypedResponse, QgridUsage } from "./types";
export type {
  FinishReason,
  GenerateTextResult,
  LanguageModelUsage,
  ModelMessage,
  Prompt,
} from "ai";
