# Agents sandbox image

Pi 에이전트는 qgrid API 프로세스 안에서 돈다(공식 `@ai-sdk/harness-pi`). 이 이미지는 그 Pi가
명령을 실행하고 파일을 읽고 쓰는 **원격 작업 환경**일 뿐이다. 안에서 아무것도 listen하지 않고,
포트를 열지 않으며, 자격증명은 어떤 형태로도 들어가지 않는다.

내용: Node 22, bash, git, gh 2.103.3, Python 3, ripgrep, curl, jq, unzip, CA 인증서, tini.
사용자는 `node`, 작업공간은 `/workspace`, 기본 명령은 `sleep infinity`다. 브라우저는 포함하지 않는다.
과제별 의존성(패키지, 브라우저 등)은 에이전트가 작업 중에 설치한다(D25).

`bash`가 반드시 있어야 한다. harness-pi의 경로 해석이 `set -o pipefail`과 `$'\n'`을 쓰고,
provider는 모든 명령을 `bash -c`로 실행한다(D27).

## 로컬 검증

```sh
docker build -t qgrid-sandbox-pi:dev deploy/sandbox-pi
docker image inspect --format '{{.Size}}' qgrid-sandbox-pi:dev
docker run --rm qgrid-sandbox-pi:dev bash -c 'set -o pipefail; node --version; python3 --version; git --version; gh --version | head -1; rg --version | head -1'
```

`image inspect` 크기는 비압축 크기이며 압축 이미지 목표는 0.5 GB 이하다.

## 버전 고정

Node 베이스는 태그·확인 날짜를 주석에 남긴 멀티아키텍처 digest로 고정한다.
gh는 공식 릴리스 버전과 아키텍처별 SHA-256을 고정한다.
Debian apt 패키지는 고정된 베이스의 Bookworm 저장소에서 받는다.
갱신 시 amd64·arm64 빌드와 위 검증을 다시 수행한다.
CI는 기존 릴리스 job 성공 후 `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<qgrid version>`을
두 아키텍처로 게시하며, 이미 게시한 버전은 덮어쓰지 않는다.
