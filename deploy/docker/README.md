# Release image

The release workflow builds and smoke-tests this image after publishing the CLI
to npm, then pushes `ghcr.io/cartanova-ai/qgrid:<CLI version>`. Images currently
target Linux amd64, matching dev0. There is no mutable `latest` deployment tag.

Build locally:

```sh
docker build --platform linux/amd64 --build-arg QGRID_VERSION=2.10.3 -t qgrid:2.10.3 deploy/docker
```

Node and Claude Code versions are pinned in the Dockerfile. The server starts
the packaged API directly, without running either CLI's update path. It runs as
UID 1000 under tini. Set `QGRID_DB_HOST`, `QGRID_DB_PORT`, `QGRID_DB_USER`,
`QGRID_DB_PASSWORD`, and `QGRID_DB_NAME` for the database. `HOST`, `PORT`, and
`NODE_ENV` default to `0.0.0.0`, `44900`, and `production`.

Alternatively, mount a JSON object at `/run/secrets/qgrid-env`. Its values take
precedence over environment variables. Never bake runtime secrets into an image.
Persist `/tmp/qgrid-anthropic-config` and `/tmp/qgrid-anthropic` if Claude session
files must survive container replacement.
