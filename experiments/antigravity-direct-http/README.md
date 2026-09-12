# Antigravity subscription HTTP experiment

This isolated experiment tests CLIProxyAPI's Antigravity OAuth and direct HTTP
transport before implementing a qgrid provider. It does not run `agy`, read its
Keychain login, connect to the qgrid database, or change the existing provider.

The reference server is pinned to CLIProxyAPI **7.2.158** (commit `5b278561`).
Release archives are checked against the SHA-256 digests published with that release.
The launcher uses Python's standard library and installs nothing globally.

## Run

From this directory:

```sh
python3 experiment.py setup
python3 experiment.py login
python3 experiment.py serve
```

Complete the Google OAuth flow opened by `login`. This creates a separate
Antigravity credential in this experiment's `data/auth/`. The existing `agy`
login is not imported. Repeat login with another account to investigate account
pooling later; one-account success does not prove multi-account isolation.

Keep `serve` running. In another terminal:

```sh
python3 experiment.py models
python3 experiment.py smoke --model <exact-id-from-models>
python3 experiment.py smoke --model <exact-id-from-models> --stream
```

Each smoke command makes one short generation request and consumes that account's
subscription quota. It checks a known output marker. Model-list success alone is
not evidence of successful upstream generation. Stop the server with Ctrl-C.

## Experiment boundaries

- The server binds to `127.0.0.1:45117` and requires a generated local API key.
- Config, API key, downloaded executable, OAuth credentials, and local state stay
  under ignored `data/`. Do not commit or share this directory.
- Management endpoints, plugins, control-panel downloads, image generation,
  extra retry rounds, alternate-model fallback, and credit fallback are disabled.
- The child receives an isolated HOME and no inherited API/provider credentials.
- No changes are made to qgrid's public API or production provider routing.
- OAuth login, model discovery, non-stream generation, and SSE must be verified
  before deciding whether to port this approach into qgrid.
- This is a third-party implementation of internal endpoints, not a Google
  supported external API contract. A successful run is point-in-time evidence.

## Sources

- [Pinned release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.158)
- [Antigravity OAuth](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/auth/antigravity.go)
- [Direct HTTP executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/internal/runtime/executor/antigravity_executor.go)
- [Configuration](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/config.example.yaml)
