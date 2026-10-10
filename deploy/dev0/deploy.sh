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
docker stack deploy --detach=true --resolve-image always -c stack.yml qgrid

for _ in $(seq 1 90); do
  IFS='|' read -r service_image update_state <<< "$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}|{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' qgrid_api)"
  if [[ "$service_image" != "$QGRID_IMAGE" || "$update_state" == paused || "$update_state" == rollback* ]]; then
    echo "The requested qgrid deployment was replaced, paused, or rolled back ($update_state)." >&2
    docker service ps --no-trunc qgrid_api
    exit 1
  fi
  tasks="$(docker service ps -q --filter desired-state=running qgrid_api)"
  for task in $tasks; do
    IFS='|' read -r task_state task_image container <<< "$(docker inspect --type task --format '{{.Status.State}}|{{.Spec.ContainerSpec.Image}}|{{if .Status.ContainerStatus}}{{.Status.ContainerStatus.ContainerID}}{{end}}' "$task")"
    if [[ "$task_state" == running && "$task_image" == "$QGRID_IMAGE" && -n "$container" ]] &&
      [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)" == healthy ]]; then
      printf 'QGRID_IMAGE=%s\n' "$QGRID_IMAGE" > deployed-image.env
      echo "qgrid $version is healthy ($QGRID_IMAGE); Swarm rollback monitoring continues."
      exit 0
    fi
  done
  sleep 2
done

echo "The requested qgrid image did not become healthy; inspect qgrid_api before retrying." >&2
docker service ps --no-trunc qgrid_api
exit 1
