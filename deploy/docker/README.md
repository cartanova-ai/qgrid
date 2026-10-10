# Release image

The release workflow packs and verifies the CLI, publishes to npm, then builds
the image from that verified tarball and pushes `ghcr.io/cartanova-ai/qgrid:<CLI version>`. Images currently
target Linux amd64, matching dev0. There is no mutable `latest` deployment tag.

Build locally:

```sh
curl --fail --location https://registry.npmjs.org/@cartanova/qgrid-cli/-/qgrid-cli-2.10.3.tgz --output deploy/docker/qgrid-cli.tgz
docker build --platform linux/amd64 --build-arg QGRID_VERSION=2.10.3 -t qgrid:2.10.3 deploy/docker
```

CI reuses the local release tarball that passed the CLI smoke check and verifies
its installed version. It does not download the just-published package again:
npm metadata and tarball propagation can lag behind a successful publish.
CI builds and tests once, copies the existing API/web output into the CLI bundle,
then packs both release packages without repeating lifecycle hooks. npm receives
those exact tarballs. Ordinary manual CLI packing retains its prepack checks.
The tarball is ignored by Git.

GitHub Actions caches the image layers. OS packages and the pinned Claude CLI
are installed before the changing qgrid tarball and version label, so a release
can reuse them. To measure a warm build of an existing version, run the workflow
manually with `benchmark_image=true`; it builds and smoke-tests without replacing
an existing published image tag.

Node and Claude Code versions are pinned in the Dockerfile. The server starts
the packaged API directly, without running either CLI's update path. It runs as
UID 1000 under tini. Set `QGRID_DB_HOST`, `QGRID_DB_PORT`, `QGRID_DB_USER`,
`QGRID_DB_PASSWORD`, and `QGRID_DB_NAME` for the database. `HOST`, `PORT`, and
`NODE_ENV` default to `0.0.0.0`, `44900`, and `production`.

Alternatively, mount a JSON object at `/run/secrets/qgrid-env`. Its values take
precedence over environment variables. Never bake runtime secrets into an image.
Persist `/tmp/qgrid-anthropic-config` and `/tmp/qgrid-anthropic` if Claude session
files must survive container replacement.
