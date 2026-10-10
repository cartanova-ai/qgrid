#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 VERSION (for example, 2.10.3)" >&2
  exit 2
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
image="ghcr.io/cartanova-ai/qgrid:$version"
docker pull "$image"
QGRID_IMAGE="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
export QGRID_IMAGE
docker stack deploy --detach=false --resolve-image always -c stack.yml qgrid

for _ in $(seq 1 90); do
  container="$(docker ps -q --filter label=com.docker.swarm.service.name=qgrid_api --filter "ancestor=$QGRID_IMAGE")"
  if [[ -n "$container" ]] && [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]; then
    printf 'QGRID_IMAGE=%s\n' "$QGRID_IMAGE" > deployed-image.env
    echo "qgrid $version is healthy ($QGRID_IMAGE)"
    exit 0
  fi
  sleep 2
done

echo "The requested qgrid image did not become healthy; inspect qgrid_api before retrying." >&2
docker service ps --no-trunc qgrid_api
exit 1
