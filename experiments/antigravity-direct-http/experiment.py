"""Isolated CLIProxyAPI Antigravity subscription transport experiment (stdlib only)."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import secrets
import subprocess
import tarfile
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
VERSION = "7.2.158"
PORT = 45117
ORIGIN = f"http://127.0.0.1:{PORT}"
RELEASES = {
    ("Darwin", "arm64"): (
        "darwin_aarch64",
        "ac8b4cc36294a88fc1ef631de03b097bef6713d8172b66630ac2727e90faf58b",
    ),
    ("Linux", "x86_64"): (
        "linux_amd64",
        "fe8d8a62c2464289e6fc10595bbb9595fbc4978f2abbf75854d052b91ecacb34",
    ),
}


def private_file(path: Path, content: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(content)
    path.chmod(0o600)


def prepare() -> None:
    DATA.mkdir(mode=0o700, exist_ok=True)
    DATA.chmod(0o700)
    for name in ("auth", "home", "logs"):
        (DATA / name).mkdir(mode=0o700, exist_ok=True)
    key_path = DATA / "api-key"
    if not key_path.exists():
        private_file(key_path, secrets.token_urlsafe(32))
    # This config uses JSON scalars inside YAML. Never print the generated API key.
    config = f"""host: "127.0.0.1"
port: {PORT}
auth-dir: {json.dumps(str(DATA / 'auth'))}
api-keys:
  - {json.dumps(key_path.read_text())}
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true
plugins:
  enabled: false
debug: false
request-log: false
logging-to-file: false
usage-statistics-enabled: false
request-retry: 0
max-retry-credentials: 1
max-retry-interval: 0
quota-exceeded:
  switch-project: false
  switch-preview-model: false
  antigravity-credits: false
disable-image-generation: true
routing:
  strategy: "round-robin"
"""
    private_file(DATA / "config.yaml", config)


def install() -> None:
    target = RELEASES.get((platform.system(), platform.machine()))
    if target is None:
        raise RuntimeError("No verified release checksum for this platform")
    asset, expected = target
    url = (
        f"https://github.com/router-for-me/CLIProxyAPI/releases/download/v{VERSION}/"
        f"CLIProxyAPI_{VERSION}_{asset}.tar.gz"
    )
    with urllib.request.urlopen(url, timeout=90) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != expected:
        raise RuntimeError("Release checksum mismatch; refusing to execute")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive.getmembers():
            name = Path(member.name).name
            if member.isfile() and name in ("cli-proxy-api", "LICENSE"):
                source = archive.extractfile(member)
                if source is not None:
                    (DATA / name).write_bytes(source.read())
                    (DATA / name).chmod(0o700 if name == "cli-proxy-api" else 0o600)
    if not (DATA / "cli-proxy-api").is_file():
        raise RuntimeError("Release archive has no executable")
    print(f"Installed checksum-verified CLIProxyAPI {VERSION} in the experiment directory")


def run_proxy(login: bool) -> int:
    binary = DATA / "cli-proxy-api"
    if not binary.exists():
        raise RuntimeError("Run setup first")
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG") if key in os.environ}
    env["HOME"] = str(DATA / "home")
    args = [str(binary), "-config", str(DATA / "config.yaml"), "-local-model"]
    if login:
        args.append("-antigravity-login")
    return subprocess.call(args, cwd=DATA, env=env)


def request(path: str, payload: dict | None = None):
    key = (DATA / "api-key").read_text()
    req = urllib.request.Request(
        ORIGIN + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        return urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as error:
        # Do not echo arbitrary upstream errors, which can contain account metadata.
        raise RuntimeError(f"Proxy returned HTTP {error.code} for {path}") from None


def models() -> list[str]:
    with request("/v1/models") as response:
        result = json.load(response)
    return sorted(item["id"] for item in result.get("data", []) if "id" in item)


def smoke(model: str, stream: bool) -> None:
    available = models()
    if model not in available:
        raise RuntimeError("Requested model is not advertised; run models and select an exact ID")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: QGRID_AG_OK"}],
        "stream": stream,
        "max_tokens": 64,
    }
    with request("/v1/chat/completions", payload) as response:
        if stream:
            text = ""
            complete = False
            for raw in response:
                line = raw.decode().strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    complete = True
                    break
                event = json.loads(data)
                if event.get("error"):
                    raise RuntimeError("Upstream stream returned an error")
                for choice in event.get("choices", []):
                    text += choice.get("delta", {}).get("content") or ""
            if not complete:
                raise RuntimeError("Stream ended without a completion marker")
            usage = None
        else:
            result = json.load(response)
            text = result["choices"][0]["message"]["content"]
            usage = result.get("usage")
    if text.strip() != "QGRID_AG_OK":
        raise RuntimeError("Model output did not match the smoke-test marker")
    print(json.dumps({"model": model, "stream": stream, "passed": True, "usage": usage}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup", "login", "serve", "models", "smoke"])
    parser.add_argument("--model")
    parser.add_argument("--stream", action="store_true")
    args = parser.parse_args()
    if args.command == "smoke" and not args.model:
        parser.error("smoke requires --model with an exact model ID")
    prepare()
    if args.command == "setup":
        install()
    elif args.command in ("login", "serve"):
        raise SystemExit(run_proxy(args.command == "login"))
    elif args.command == "models":
        print(json.dumps(models(), indent=2))
    else:
        smoke(args.model, args.stream)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(str(error)) from None
