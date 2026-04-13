/**
 * @cartanova/qgrid-sdk — Qgrid HTTP 클라이언트.
 * QGRID_URL 환경변수로 서버 주소 설정 (기본: http://localhost:44900)
 */
import { z } from "zod";

import { type QgridResponse, type QgridTypedResponse } from "./types";

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

export async function generateText<T extends z.ZodType | undefined = undefined>(params: {
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

export type { QgridBase, QgridResponse, QgridTypedResponse, QgridUsage } from "./types";
