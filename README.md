# Qgrid (Quota Grid)

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출하는 사내 프록시 서비스.

---

## SDK (`@qgrid/sdk`)

```bash
pnpm add @qgrid/sdk
```

```typescript
import { generateText } from "@qgrid/sdk";

// 텍스트 응답
const { text } = await generateText({
  prompt: "Hello",
  system: "Reply briefly.",
});

// 구조화 응답 (Zod 스키마 → JSON Schema 자동 포함 + 파싱/검증)
const { json } = await generateText({
  prompt: "질문 5개 생성해줘",
  system: "질문 생성 전문가입니다.",
  returnType: z.object({ questions: z.array(z.string()) }),
});
json.questions // string[]
```

환경변수 `QGRID_URL`로 서버 주소 설정 (기본: `http://localhost:44900`)

---

## 시작하기

### 로컬 개발

```bash
git clone https://github.com/cartanova-ai/Qgrid.git
cd Qgrid
pnpm install
cp packages/api/.env.example packages/api/.env  # DB 설정 수정
pnpm -C packages/api sonamu dev
```

### Docker

```bash
docker compose up -d --build
```

### 토큰 등록

브라우저에서 `http://localhost:44900` 접속 → **"Login with Claude"** 로 OAuth 로그인 (권장)

또는 수동: Tokens 페이지 → Add Token → `claude setup-token`으로 발급한 토큰 붙여넣기

---

## 아키텍처

```
dev0 (EC2)                         각 팀원 로컬
┌────────────┐                    ┌──────────────────────┐
│ PostgreSQL  │ ◄──── DB 연결 ──── │ Qgrid 서버            │
│ - tokens    │                    │  ├─ API 서버 (:44900) │
│ - logs      │                    │  ├─ 대시보드 웹 UI     │
│ - usage     │                    │  ├─ Worker Pool       │
└────────────┘                    │  └─ claude -p ×N      │
                                  └──────────────────────┘
```

- N개 계정 토큰 등록 → 쿼터 풀링
- least-queue-depth 라우팅 (가장 여유있는 워커에 배정)
- 쿼터 소진 시 자동 failover (호출자는 모름)
- 프로세스당 500콜 후 자동 재시작 (1M 컨텍스트 한계 방지)
- 매 요청의 토큰 사용량을 DB에 기록

## 패키지 구조

```
packages/
├── api/     ← Sonamu 서버 (개발용)
├── web/     ← 대시보드 React 앱
├── sdk/     ← @qgrid/sdk (npm 패키지)
└── cli/     ← @qgrid/cli (npm 패키지)
```

## 대시보드

`http://localhost:44900` 접속:

- **Service Health** — 서비스 상태, 워커 수, 활성 토큰 수
- **Usage** — 토큰별 5시간/7일 쿼터 사용률 (Anthropic API 실시간 조회, OAuth 토큰 필요)
- **Request Log** — 요청별 query, input/output/cache 토큰, cache hit rate
- **Request Detail** — 전체 prompt + response + 토큰 breakdown

## API

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/qgrid/query` | POST | LLM 쿼리 (prompt, system?, timeout?) |
| `/api/qgrid/stats` | GET | 토큰별 상태 |
| `/api/qgrid/addToken` | POST | 토큰 추가 (수동) |
| `/api/qgrid/updateToken` | POST | 토큰 수정 |
| `/api/qgrid/removeToken` | POST | 토큰 제거 |
| `/api/qgrid/oauthLogin` | POST | OAuth 로그인 (브라우저) |
| `/api/qgrid/usage` | GET | 쿼터 사용률 (tokenName?) |
| `/api/qgrid/health` | GET | 헬스체크 |
| `/api/requestLog/findMany` | GET | 요청 로그 목록 |
| `/api/requestLog/findById` | GET | 요청 로그 상세 |

---

## 주의사항

- **쿼터 리셋**: Claude 5시간 rolling window. 소진된 토큰은 자동 failover
- **PostgreSQL 필수**: 토큰 관리 + 요청 로그 저장
- **OAuth 토큰**: 자동 refresh. Usage API 조회에는 OAuth 토큰 필요
