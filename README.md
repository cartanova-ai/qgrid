# Qgrid (Quota Grid)

Claude 구독 크레딧을 HTTP API로 사용할 수 있게 해주는 LLM 프록시 서버.

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출. N개 계정의 쿼터를 풀링하여 자동 failover.

---

## 아키텍처

```
┌─────────────────────────────────────────────┐
│  Docker (qgrid start)                       │
│  ┌──────────────────────┐  ┌─────────────┐  │
│  │ Qgrid Server (:44900)│  │ PostgreSQL  │  │
│  │ ├─ Worker Pool       │  │ (:44901)    │  │
│  │ │  └─ claude -p ×N   │→ │ tokens      │  │
│  │ ├─ 대시보드 웹 UI     │  │ request_logs│  │
│  │ └─ OAuth / Usage API │  └─────────────┘  │
│  └──────────────────────┘                   │
└─────────────────────────────────────────────┘
        ▲
        │ HTTP
        │
  import { generateText } from "@qgrid/sdk"
```

- **멀티 토큰 풀링** — N개 구독 계정 등록, least-queue-depth 라우팅
- **자동 failover** — 쿼터 소진 시 다른 토큰으로 투명 전환
- **OAuth 로그인** — Claude 계정으로 원클릭 토큰 발급/갱신
- **Usage API** — Anthropic 서버에서 실시간 쿼터 사용률 조회
- **Request Log** — 매 요청의 토큰 사용량/캐시 히트율 DB 기록

---

## 빠른 시작

### 서버 실행 (CLI)

```bash
~~npm i -g @qgrid/cli~~  # (아직 npm publish 전)

qgrid start                    # PostgreSQL + Qgrid 서버 Docker로 실행
qgrid start --db-host dev0...  # 외부 DB 연결 (PostgreSQL 안 띄움)
qgrid stop                     # 중지
qgrid status                   # 상태 확인
```

서버가 뜨면 `http://localhost:44900`에서 대시보드 접속 → **Login with Claude**로 토큰 등록.

### SDK 사용

~~`pnpm add @qgrid/sdk`~~ (아직 npm publish 전 — `pnpm link` 또는 `file:` 프로토콜로 로컬 연결)

```typescript
import { generateText } from "@qgrid/sdk";

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
qgrid start [options]

  --port <port>           서버 포트 (기본: 44900)
  --db-host <host>        외부 DB 호스트 (지정하면 로컬 PostgreSQL 안 띄움)
  --db-port <port>        DB 포트 (기본: 44901)
  --db-user <user>        DB 유저 (기본: postgres)
  --db-password <pass>    DB 비밀번호 (기본: postgres)
```

CLI는 내부적으로 `~/.qgrid/docker-compose.yml`을 자동 생성하고 Docker Compose를 실행. 사용자 디렉터리에 파일을 남기지 않음.

---

## 팀 사용 (공유 DB)

팀원들이 같은 DB를 공유하면 토큰 풀을 함께 사용할 수 있음:

```bash
# 서버 운영자가 한 번
qgrid start --db-host dev0.example.com --db-user qgrid --db-password xxx

# 각 팀원 프로젝트에서
QGRID_URL=http://서버주소:44900
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
├── sdk/   ← @qgrid/sdk (npm 패키지, ESM only)
└── cli/   ← @qgrid/cli (npm 패키지, Docker compose 래퍼)
```

### 포트

| 용도 | 포트 |
|------|------|
| Qgrid 서버 | 44900 |
| PostgreSQL | 44901 |

---

## 주의사항

- **Claude CLI 필수** — Qgrid 서버가 내부적으로 `claude -p`를 spawn. Docker 이미지에 포함됨.
- **쿼터 리셋** — Claude 5시간 rolling window. 소진된 토큰은 자동 failover.
- **OAuth 토큰** — 자동 refresh. Usage API 조회에는 OAuth 토큰 필요.
- **setup-token 방식 중단** — 2026-04-04부로 Anthropic이 서드파티 하네스의 구독 토큰 사용을 차단. `claude setup-token`으로 발급한 토큰은 더 이상 사용 불가. OAuth 로그인만 지원.
