# ByCC (By Claude Code)

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출

---

## SDK

`packages/api/src/sdk/@bycc/index.ts`를 프로젝트에 복사해서 사용합니다. (의존성: `zod`)

```typescript
import { generateByCC } from "./bycc";

// 텍스트 응답
const { text } = await generateByCC({
  prompt: "Hello",
  system: "Reply briefly.",
});

// 구조화 응답 (Zod 스키마 → JSON Schema 자동 포함 + 파싱/검증)
const { json } = await generateByCC({
  prompt: "질문 5개 생성해줘",
  system: "질문 생성 전문가입니다.",
  returnType: z.object({ questions: z.array(z.string()) }),
});
json.questions // string[]
```

---

## 시작하기

### Docker (권장)

```bash
git clone git@github.com:CartaNova-AI/ByCC.git
cd ByCC
docker compose up -d --build
```

PostgreSQL + ByCC 서버가 시작됩니다. DB 생성은 자동.

### 로컬 개발

```bash
pnpm install
cp packages/api/.env.example packages/api/.env  # DB 설정 수정
bash packages/api/database/fixtures/init.sh      # DB 3개 생성 (bycc, bycc_fixture, bycc_test)
pnpm -C packages/api sonamu dev
```

### 토큰 등록

브라우저에서 `http://localhost:44900` 접속 → **"Login with Claude"** 로 OAuth 로그인 (권장)

또는 수동: Tokens 페이지 → Add Token → `claude setup-token`으로 발급한 토큰 붙여넣기

---

## 어떻게 동작하는가

```
프로젝트 (Node.js / Python / 뭐든)
  req: POST http://bycc:44900/api/bycc/query
  res: { text, usage, durationMs, costUsd }

ByCC 서버
  ├── ClaudePool (멀티 토큰 프로세스 풀)
  │     ├── Worker A-0 (token=계정A) → claude CLI 프로세스
  │     ├── Worker A-1 (token=계정A) → claude CLI 프로세스
  │     ├── Worker B-0 (token=계정B) → claude CLI 프로세스
  │     └── Worker B-1 (token=계정B) → claude CLI 프로세스
  └── PostgreSQL → request_logs 테이블 (요청별 토큰 상세 기록)
```

- N개 계정 토큰 등록 → 쿼터 풀링
- least-queue-depth 라우팅 (가장 여유있는 워커에 배정)
- 쿼터 소진 시 자동 failover (호출자는 모름)
- 프로세스당 500콜 후 자동 재시작 (1M 컨텍스트 한계 방지)
- 매 요청의 토큰 사용량(input/output/cache read/cache write)을 DB에 기록

## 대시보드

`http://localhost:44900` 접속:

- **Service Health** — 서비스 상태, 워커 수, 활성 토큰 수
- **Usage** — 토큰별 5시간/7일 쿼터 사용률 (Anthropic API 실시간 조회, OAuth 토큰 필요)
- **Request Log** — 요청별 query, input/output/cache 토큰, cache hit rate
- **Request Detail** — 전체 prompt + response + 토큰 breakdown

## API

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/bycc/query` | POST | LLM 쿼리 (prompt, system?, timeout?) |
| `/api/bycc/stats` | GET | 토큰별 상태 |
| `/api/bycc/addToken` | POST | 토큰 추가 (수동) |
| `/api/bycc/updateToken` | POST | 토큰 수정 |
| `/api/bycc/removeToken` | POST | 토큰 제거 |
| `/api/bycc/oauthLogin` | POST | OAuth 로그인 (브라우저) |
| `/api/bycc/usage` | GET | 쿼터 사용률 (tokenName?) |
| `/api/bycc/health` | GET | 헬스체크 |
| `/api/requestLog/findMany` | GET | 요청 로그 목록 |
| `/api/requestLog/findById` | GET | 요청 로그 상세 |

---

## 주의사항

- **쿼터 리셋**: Claude 5시간 rolling window. 소진된 토큰은 자동 failover
- **PostgreSQL 필수**: 요청 로그 저장 + Sonamu 프레임워크 시작 시 DB 연결 필수
- **토큰 파일**: `data/bycc-tokens.json`에 저장 (`.gitignore` 처리됨)
- **OAuth 토큰**: 8시간 만료, 자동 refresh. Usage API 조회에는 OAuth 토큰 필요 (setup-token으로는 불가)
