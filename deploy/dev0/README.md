# dev0 Swarm deployment

This deployment keeps qgrid 2.10.2 and Claude Code 2.1.296, the versions installed
on dev0 before the PM2 migration. It runs one replica, constrained to dev0.
The packaged server starts directly so neither qgrid nor Claude Code updates at
startup. Node runs as UID 1000 under tini.

The external host network preserves the existing `172.19.0.1:44900` Caddy
upstream and loopback OAuth callback listeners. No new port is published. Keep
the existing Caddy authentication rules. The existing PostgreSQL database is
used without moving its data or changing its credentials.

Runtime environment values are stored in the external Docker secret
`qgrid-dev0-env-20261010`, sourced from the live PM2 process. Never commit the
secret or the old ecosystem configuration. The entrypoint maps `QGRID_DB_*` to
the internal `SONAMU_DB_*` variables, as the packaged CLI does.

Persistent data on dev0:

- `/mnt/data-ssd/qgrid/anthropic-config` mounts at `/tmp/qgrid-anthropic-config`.
- `/mnt/data-ssd/qgrid/anthropic-cwd` mounts at `/tmp/qgrid-anthropic`.
- `/home/cartanova/qgrid-swarm` holds the deployment files and build log.

Build and deploy on dev0 from `/home/cartanova/qgrid-swarm`:

```sh
docker build -t qgrid-dev0:2.10.2-claude-2.1.296 .
docker stack deploy --resolve-image never -c stack.yml qgrid
docker service ps qgrid_api
curl -fsS http://172.19.0.1:44900/api/qgrid/health
```

The image is local to dev0, matching its placement constraint. Change both the
Dockerfile versions and the stack image tag for an upgrade. Swarm image rollback
does not undo database migrations; assess migrations separately before upgrades.

Restart using `docker service update --force qgrid_api`. The dashboard restart
button remains disabled because this release recognizes only PM2. Updates use
`stop-first`; active responses can be interrupted because this qgrid release has
no SIGTERM drain handler. Use a quiet traffic window. The health check allows
three minutes for startup.

PM2, its logrotate module, reboot cron entry, logs, and old deployment settings
were removed after the Swarm migration at the user's request. Swarm now owns
the process lifecycle; there is no retained PM2 rollback configuration.
The full database backup was canceled at the user's request; this migration
preserves the existing database in place and does not change qgrid's version.
