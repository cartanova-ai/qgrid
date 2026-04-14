# @cartanova/qgrid-sdk

Qgrid 서버의 HTTP 클라이언트. LLM 호출을 한 줄로.

## 설치

```bash
pnpm add @cartanova/qgrid-sdk
```

## 사용법

```typescript
import { generateText } from "@cartanova/qgrid-sdk";

// 텍스트 응답
const { data } = await generateText({
  prompt: "Hello",
  system: "Reply briefly.",
});
// data: "Hi there!"

// 구조화 응답 (Zod 스키마)
import { z } from "zod";

const { data } = await generateText({
  prompt: "질문 5개 생성해줘",
  system: "질문 생성 전문가입니다.",
  returnType: z.object({ questions: z.array(z.string()) }),
});
data.questions // string[]
```

JSON Schema 변환 + 파싱/검증을 자동으로 처리. 파싱 실패 시 최대 3회 재시도.

## 옵션

```typescript
generateText({
  prompt: string;          // 필수
  system?: string;         // 시스템 프롬프트
  returnType?: z.ZodType;  // Zod 스키마 → JSON 응답 강제 + 파싱
  timeout?: number;        // 타임아웃 ms (기본: 300000)
  serverUrl?: string;      // 서버 URL (기본: QGRID_URL 환경변수 또는 http://localhost:44900)
  maxAttempts?: number;    // JSON 파싱 재시도 횟수 (기본: 3)
})
```

## 응답

```typescript
{
  data: string | T;  // 텍스트 또는 파싱된 객체
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  durationMs: number;
  costUsd: number;
}
```

## 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `QGRID_URL` | Qgrid 서버 주소 | `http://localhost:44900` |

## 에러

```typescript
import { QgridError } from "@cartanova/qgrid-sdk";

try {
  await generateText({ prompt: "..." });
} catch (e) {
  if (e instanceof QgridError) {
    e.code;    // "QUOTA_EXHAUSTED" | "SERVER_UNAVAILABLE" | "REQUEST_FAILED" | "PARSE_FAILED"
    e.status;  // HTTP status code
  }
}
```

## 요구사항

- Node.js >= 20
- `zod` ^3.23.0 || ^4.0.0 (peer dependency)
