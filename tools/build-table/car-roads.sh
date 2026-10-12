#!/usr/bin/env bash
# Prepares the road network for the car job and starts OSRM on localhost:$OSRM_PORT (default 5000):
# download Sweden from Geofabrik, cut out the area around Göteborg, run OSRM's preprocessing.
# Usage: car-roads.sh [work dir]   (needs docker; osmium is used from PATH, or run in a container)
set -euo pipefail
DIR=$(cd "${1:-/tmp/osm}" 2>/dev/null && pwd || (mkdir -p "${1:-/tmp/osm}" && cd "${1:-/tmp/osm}" && pwd))
IMAGE=ghcr.io/project-osrm/osrm-backend:v6.0.0
PORT=${OSRM_PORT:-5000}
BBOX=$(node "$(dirname "$0")/car.js" --bbox)
osmium_run() {
  if command -v osmium >/dev/null; then osmium "$@"
  else docker run --rm -v "$DIR:$DIR" -w "$DIR" ubuntu:24.04 bash -c \
    "apt-get update -qq >/dev/null && apt-get install -y -qq osmium-tool >/dev/null && osmium $*"; fi
}
if [ ! -f "$DIR/sweden.osm.pbf" ]; then
  echo "Hämtar vägnätet för Sverige"
  curl -sSfL -o "$DIR/sweden.osm.pbf" https://download.geofabrik.de/europe/sweden-latest.osm.pbf
fi
echo "Klipper ut $BBOX"
osmium_run extract -b "$BBOX" "$DIR/sweden.osm.pbf" -o "$DIR/region.osm.pbf" --overwrite
for step in "osrm-extract -p /opt/car.lua /data/region.osm.pbf" "osrm-partition /data/region.osrm" "osrm-customize /data/region.osrm"; do
  echo "$step"
  docker run --rm -v "$DIR:/data" "$IMAGE" $step >/dev/null
done
docker rm -f osrm >/dev/null 2>&1 || true
docker run -d --name osrm -p "$PORT:5000" -v "$DIR:/data" "$IMAGE" osrm-routed --algorithm mld --max-table-size 1000 /data/region.osrm >/dev/null
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/nearest/v1/driving/11.9735,57.7089" >/dev/null; then echo "OSRM är igång"; exit 0; fi
  sleep 2
done
echo "OSRM startade inte" >&2
docker logs osrm >&2 || true
exit 1
