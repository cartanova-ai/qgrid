# dev0 Swarm deployment

Release images are published as `ghcr.io/cartanova-ai/qgrid:VERSION` by
`.github/workflows/build-and-publish.yml`, after npm publication and container
smoke checks. The image installs the verified release tarball of that CLI version. Existing
image tags are not rebuilt; changes to the image require a new CLI release.

After the first publication, set the `qgrid` container package to **Public** in
the GitHub organization's package settings. GitHub initially creates private
packages even for public repositories. Confirm an unauthenticated pull before
using dev0's deployment command. No registry credentials belong on dev0.

Copy `stack.yml`, `deploy.sh`, and this README to `/home/cartanova/qgrid-swarm`.
Deploy a published version from that directory:

```sh
bash deploy.sh 2.10.3
```

The script pulls the image before changing the service, resolves its immutable
digest, deploys the stack, and checks the requested container's health. On
success, `deployed-image.env` records the deployed digest. Releases do not
automatically upgrade dev0; deployment is an explicit operation.

The stack runs one replica constrained to dev0. Host networking preserves the
existing `172.19.0.1:44900` Caddy upstream and loopback OAuth callbacks. No new
port is published. Keep the existing Caddy authentication rules.

Runtime values remain in the external Docker secret `qgrid-dev0-env-20261010`.
The image's optional `/run/secrets/qgrid-env` JSON file overrides environment
values. Public `QGRID_DB_*` values are mapped to `SONAMU_DB_*` just as in the CLI.
The existing PostgreSQL database is retained in place. Persistent session data:

- `/mnt/data-ssd/qgrid/anthropic-config` mounts at `/tmp/qgrid-anthropic-config`.
- `/mnt/data-ssd/qgrid/anthropic-cwd` mounts at `/tmp/qgrid-anthropic`.

Swarm owns restart and recovery. Updates use `stop-first`; active responses can
be interrupted because qgrid has no SIGTERM drain handler. Use a quiet traffic
window. The health check allows three minutes for startup.

Operational commands:

```sh
docker service ps qgrid_api
curl -fsS https://qgrid.cartanova.ai/api/qgrid/health
docker service update --force qgrid_api
docker service rollback qgrid_api
```

Image rollback does not reverse database migrations. Check release migrations
before upgrading or rolling back. Re-run the deploy script with the intended
version to reconcile a manual rollback. PM2 and its old settings were removed;
there is no retained PM2 rollback path. No database backup is created by deploy.
