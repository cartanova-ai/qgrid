# Pi sandbox

단일 이미지에 Node 22, git, gh 2.103.3, Python 3, ripgrep, curl, jq, unzip,
CA 인증서, tini와 `/opt/qgrid-pi-bridge`의 Pi SDK·harness bridge를 설치한다.
사용자는 `node`, 작업공간은 `/workspace`이며 기본 명령은 `sleep infinity`다.
브라우저는 포함하지 않는다.

## 로컬 검증

```sh
docker build -t qgrid-sandbox-pi:dev deploy/sandbox-pi
docker image inspect --format '{{.Size}}' qgrid-sandbox-pi:dev
docker run --rm --name qgrid-pi-smoke \
  -e BRIDGE_CHANNEL_TOKEN=x \
  -e OPENAI_BASE_URL=http://127.0.0.1:1/backend-api/codex \
  -e CODEX_API_KEY=aisdkhc_placeholder \
  qgrid-sandbox-pi:dev node /opt/qgrid-pi-bridge/bridge.mjs \
  --workdir /workspace --bridge-state-dir /tmp/bs
```

`{"type":"bridge-ready","port":8787}`를 확인한다. 다른 터미널에서 컨테이너의
Node WebSocket 클라이언트로 인증을 확인할 수 있다(호스트 포트 공개 불필요).

```sh
docker exec -i qgrid-pi-smoke node --input-type=module <<'JS'
import assert from 'node:assert/strict';
for (const token of ['x', 'wrong']) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    const ws = new WebSocket(`ws://127.0.0.1:8787/?agent_bridge_token=${token}`);
    let hello = false;
    ws.onmessage = ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type === 'bridge-hello') { hello = true; ws.close(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
    ws.onclose = ({ code }) => {
      clearTimeout(timer);
      try {
        assert.equal(hello, token === 'x');
        if (token !== 'x') assert.equal(code, 1008);
        resolve();
      } catch (error) { reject(error); }
    };
  });
}
console.log('hello and token rejection passed');
JS
```

위 자격증명은 기동 검증용 더미다. 모델 호출에는 qgrid relay가 필요하다.
`image inspect` 크기는 비압축 크기이며 압축 이미지 목표는 0.5 GB 이하다.

## 세션과 지시

start의 `sessionId` 또는 `resume` 문자열로 `~/.pi-session/<id>.jsonl`을 연다.
둘 다 없으면 ID를 생성해 `--bridge-state-dir/pi-session-id`에 보관한다.
stop 응답의 `piSession`을 다음 start의 `resume`으로 사용할 수 있다.
`SessionManager.open()`은 파일이 없으면 생성하고 있으면 복원한다.
instructions는 `DefaultResourceLoader.appendSystemPrompt`로 추가하며
작업공간 AGENTS.md도 그대로 읽는다.
PoC의 선택적 프로필 자동 감지는 사용하지 않는다.

## 버전 고정

Node 베이스는 태그·확인 날짜를 주석에 남긴 멀티아키텍처 digest로 고정한다.
gh는 공식 릴리스 버전과 아키텍처별 SHA-256을 고정한다.
bridge 직접 의존성은 정확 버전, 전이 의존성은 `package-lock.json`과 `npm ci`로 고정한다.
Debian apt 패키지는 고정된 베이스의 Bookworm 저장소에서 받는다.
갱신 시 amd64·arm64 빌드와 위 기동 검증을 다시 수행한다.
CI는 기존 릴리스 job 성공 후 `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<qgrid version>`을
두 아키텍처로 게시하며, 이미 게시한 버전은 덮어쓰지 않는다.
