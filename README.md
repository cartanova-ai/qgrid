# Qgrid (Quota Grid)

Claude 구독 크레딧을 HTTP API로 사용할 수 있게 해주는 LLM 프록시 서버.

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출. N개 계정의 쿼터를 풀링하여 자동 failover.

---

## 아키텍처

```
팀원 A 로컬                          팀원 B 로컬
┌──────────────────────┐            ┌──────────────────────┐
│ qgrid (:44900)       │            │ qgrid (:44900)       │
│ ├─ Worker Pool       │            │ ├─ Worker Pool       │
│ │  └─ claude -p ×N   │            │ │  └─ claude -p ×N   │
│ ├─ 대시보드 웹 UI     │            │ ├─ 대시보드 웹 UI     │
│ └─ OAuth / Usage API │            │ └─ OAuth / Usage API │
└──────────┬───────────┘            └──────────┬───────────┘
           │                                   │
           └──────────┐  ┌─────────────────────┘
                      ▼  ▼
              ┌─────────────────┐
              │ PostgreSQL (공유)│
              │ ├─ tokens       │
              │ └─ request_logs │
              └─────────────────┘
```

- **멀티 토큰 풀링** — N개 구독 계정 등록, least-queue-depth 라우팅
- **자동 failover** — 쿼터 소진 시 다른 토큰으로 투명 전환
- **OAuth 로그인** — Claude 계정으로 원클릭 토큰 발급/갱신
- **Usage API** — Anthropic 서버에서 실시간 쿼터 사용률 조회
- **Request Log** — 매 요청의 토큰 사용량/캐시 히트율 DB 기록

---

## 빠른 시작

### 사전 요구사항

- Node.js >= 20
- [Claude CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) (`npm i -g @anthropic-ai/claude-code`)
- 접속 가능한 PostgreSQL (팀 공유 DB 또는 로컬)

### 서버 실행

```bash
npm i -g @cartanova/qgrid-cli

# DB URL로 실행
qgrid --db postgres://user:password@host:port/dbname

# 또는 쉘 환경변수로 설정해두면 플래그 없이 실행
export QGRID_DB_HOST=dev0.example.com
export QGRID_DB_PORT=5432
export QGRID_DB_USER=postgres
export QGRID_DB_PASSWORD=postgres
export QGRID_DB_NAME=qgrid
qgrid
```

서버가 뜨면 `http://localhost:44900`에서 대시보드 접속 → **Login with Claude**로 토큰 등록.

Ctrl+C로 종료.

### SDK 사용

```bash
pnpm add @cartanova/qgrid-sdk
```

```typescript
import { generateText } from "@cartanova/qgrid-sdk";

// 텍스트 응답
const { data } = await generateText({
  prompt: "Hello",
  system: "Reply briefly.",
});
// data: string

// 구조화 응답 (Zod 스키마 → JSON Schema 자동 변환 + 파싱/검증)
const { data } = await generateText({
  prompt: "질문 5개 생성해줘",
  system: "질문 생성 전문가입니다.",
  returnType: z.object({ questions: z.array(z.string()) }),
});
data.questions // string[]
```

환경변수 `QGRID_URL`로 서버 주소 설정 (기본: `http://localhost:44900`)

---

## CLI 옵션

```
qgrid [options]

  --db <url>         PostgreSQL 연결 URL (postgres://user:pw@host:port/dbname)
  -p, --port <port>  서버 포트 (기본: 44900)
```

`--db`를 생략하면 `QGRID_DB_*` 환경변수에서 읽음. 환경변수도 없으면 기본값(`localhost:44901`)으로 시도.

---

## 팀 사용 (공유 DB)

팀원들이 같은 DB를 공유하면 토큰 풀을 함께 사용할 수 있음:

```bash
# 각 팀원 로컬에서 (같은 DB를 바라봄)
qgrid --db postgres://user:pw@dev0.example.com:5432/qgrid

# 각 팀원 프로젝트에서
QGRID_URL=http://localhost:44900
```

---

## 개발

```bash
git clone https://github.com/cartanova-ai/Qgrid.git
cd Qgrid
pnpm install
cp packages/api/.env.example packages/api/.env  # DB 설정 수정
pnpm -C packages/api sonamu dev
```

### 패키지 구조

```
packages/
├── api/   ← Sonamu 서버 (개발용, HMR)
├── web/   ← 대시보드 React 앱 (TanStack Router + Query)
├── sdk/   ← @cartanova/qgrid-sdk (npm 패키지)
└── cli/   ← @cartanova/qgrid-cli (npm 패키지, 서버 번들 포함)
```

---

## 주의사항

- **Claude CLI 필수** — Qgrid 서버가 내부적으로 `claude -p`를 spawn. 호스트 머신에 설치 필요.
- **쿼터 리셋** — Claude 5시간 rolling window. 소진된 토큰은 자동 failover.
- **OAuth 토큰** — 자동 refresh. Usage API 조회에는 OAuth 토큰 필요.
- **setup-token 방식 중단** — 2026-04-04부로 Anthropic이 서드파티의 구독 토큰 사용을 차단. OAuth 로그인만 지원.
