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
digest, deploys the stack without waiting for Swarm's update monitor, and checks
the requested image's running service task. It returns success as soon as that
container is healthy; paused or rolled-back updates fail. Swarm's 240-second
monitor and automatic rollback remain active after the command exits. A later
failure can still roll back the service, so `deployed-image.env` records the digest
that became healthy, not a guarantee of the currently running image. Releases do not
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

## Enable Agents on dev0

Agents is disabled by default. Apply these changes manually to the deployed
stack during an operator-controlled update; the repository's `stack.yml` is not
changed by this procedure. Keep one API replica owning the retained sessions,
the existing host network, and Caddy authentication.

The 2026-11-08 dev0 inspection found `/var/run/docker.sock` owned by `root:983`
with mode 660, while the API runs as `node` (UID 1000). Merge this example into
`services.api`, preserving its existing volumes, secret, and other settings:

```yaml
services:
  api:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    group_add: ["983"]
    environment:
      QGRID_AGENTS_ENABLED: "true"
      QGRID_AGENTS_SECRET: "<STABLE_RANDOM_AGENTS_SECRET>"
      QGRID_AGENTS_SANDBOX_IMAGE: "ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>"
```

Use the existing secret-management procedure for the real secret value; do not
commit it in YAML. `/run/secrets/qgrid-env` overrides process environment, and
stored `qgrid.agents.*` DB settings override environment settings. Resolve any
conflicting values before restarting. Preserve the same HMAC secret while
sessions are retained. Verify that the deployed API process actually has socket
access and supplementary GID 983. Mount the socket only in the API container;
the provider creates sandboxes without host mounts.

Pull the matching published sandbox image on dev0 before startup; the provider
does not pull it automatically:

```sh
docker pull ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>
```

The runtime creates the dedicated `qgrid-agents` bridge (`172.30.0.0/24`) with
interface `br-qgrid-agents`. Relay listens on its gateway `172.30.0.1:44901` and
loopback. Dev0's existing ufw default deny already blocks incoming traffic from
this new bridge; add only the relay allow rule:

```sh
sudo ufw allow in on br-qgrid-agents to 172.30.0.1 port 44901 proto tcp
```

No extra deny rule is needed under that existing firewall policy. Do not put
sandboxes on docker0: dev0 permits host access from docker0. Preserve the API's
`172.19.0.1:44900` binding and block sandbox access to it and other host services.
Linux host-local traffic traverses INPUT; DOCKER-USER rules alone do not protect
those services. Internet egress for GitHub and package installation remains
necessary. If the subnet or relay port changes, update the allow rule to match.

Deploy the prepared stack using the normal operator procedure, then check the
Agents-specific health result:

```sh
curl -fsS https://qgrid.cartanova.ai/api/qgrid/health | jq '.agents'
```

Require `enabled: true` and `ready: true`. Overall API health can be ready even
when Agents is unavailable. Startup creates a temporary probe container: relay
TCP must be reachable, while the API port and default blocked ports 5432/6379
must be unreachable through the host alias, bridge gateway, and configured API
address. The default `QGRID_AGENTS_ISOLATION_CHECK=enforce` leaves Agents
unavailable on failure and reports `agents.reason`; fix the reported socket,
image, configuration, or network problem before retrying. `warn` is for local
development, not dev0. The probe does not install firewall rules, and the current
`deploy.sh` does not check Agents firewall configuration.

Keep the default 20 GiB free-space guard unless an operator deliberately changes
it. The runner checks Docker data-root space, with a container `df` fallback when
that path is not visible in the API container. Enabling Agents does not require
pruning shared Docker resources or moving Docker's data-root.

For live verification, use `packages/api/scripts/agents/smoke.ts` as documented in
`packages/cli/skills/qgrid/references/agents-runtime.md`. Run S12 from the Linux
host against the same daemon to verify host-port blocking and GitHub reachability.
Restart/SIGKILL scenarios belong on a designated test instance, not an incidental
deployment health check.
