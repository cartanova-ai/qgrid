# ByCC (By Claude Code)

Anthropic API 키(토큰 과금) 대신 **구독 정액제 크레딧**으로 LLM을 호출

---

## 수동 SDK

`packages/api/src/sdk/bycc.ts`를 프로젝트에 복사해서 사용합니다. (의존성: `zod`)

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

### 1. 클론 + 설치

```bash
git clone git@github.com:CartaNova-AI/ByCC.git
cd ByCC
pnpm install
```

### 2. 토큰 발급

각 팀원이 자기 Claude Max/Team 계정에서 long-lived 토큰 발급:

```bash
claude setup-token
```

### 3. DB 준비

ByCC는 요청 로그를 PostgreSQL에 저장합니다. DB 구조가 필요합니다:

```bash
cd packages/api
bash database/init.sh
```

이 스크립트가 `bycc`, `bycc_fixture`, `bycc_test` 3개 DB를 생성합니다.
기본 설정: `localhost:5444`, user: `postgres`, password: `1234` (`.env`에서 변경)

### 4. 서버 시작

```bash
# 개발 모드
pnpm -C packages/api sonamu dev

# Docker
docker compose up -d --build
```

### 5. 토큰 등록

브라우저에서 `http://localhost:44900` 접속 → Tokens 페이지에서 추가.

---

## 어떻게 동작하는가

```
프로젝트 (Node.js / Python / 뭐든)
  req: POST http://bycc:44900/api/bycc/query
  res: { text, usage, durationMs, costUsd }

ByCC 서버
  ├── ClaudePool (멀티 토큰 프로세스 풀) (N개 지원 예정)
  │     ├── Worker A-0 (token=계정A) → claude CLI 프로세스
  │     ├── Worker A-1 (token=계정A) → claude CLI 프로세스
  │     ├── Worker B-0 (token=계정B) → claude CLI 프로세스
  │     └── Worker B-1 (token=계정B) → claude CLI 프로세스
  └── PostgreSQL → request_logs 테이블 (요청별 토큰 상세 기록)
```

- N개 계정 토큰을 등록하면 쿼터를 풀링
- 가장 여유있는 워커에 요청을 배정 (least-queue-depth)
- 한 토큰이 쿼터 소진되면 자동으로 다른 토큰으로 failover (호출자는 모름)
- 프로세스당 500콜 후 자동 재시작 (1M 컨텍스트 한계 방지)
- 매 요청의 토큰 사용량(input/output/cache read/cache write)을 DB에 기록

## 대시보드

`http://localhost:44900` 접속 시 대시보드 확인 가능:

- **Service Health** — 서비스 상태, 워커 수, 활성 토큰 수
- **Request Log** — 요청별 query, input/output/cache 토큰, cache hit rate
- **Request Detail** — 상세 페이지에서 전체 prompt + response + 토큰 breakdown

---

## 배포

앱의 docker-compose에 bycc 서비스를 추가:

```yaml
services:
  api:
    environment:
      BYCC_URL: http://bycc:44900

  bycc:
    build: ./ByCC
    volumes:
      - ./data:/app/data
    environment:
      DB_HOST: your-postgres-host
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASSWORD: your-password
      DB_NAME: bycc
```

---

## 주의사항

- **쿼터 리셋**: Claude Max 5시간 rolling window. 소진된 토큰은 웹 UI에서 수동 재활성화
- **PostgreSQL 필수**: 요청 로그 저장 + Sonamu 프레임워크 시작 시 DB 연결 필수
- **토큰 파일**: `data/bycc-tokens.json`에 저장 (`.gitignore` 처리됨)
- **macOS Docker**: `DB_HOST`가 기본 `host.docker.internal` (호스트 머신의 localhost를 가리킴). Linux에서는 `network_mode: host` 사용
