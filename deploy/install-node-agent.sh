#!/usr/bin/env bash
#
# sparkDash node-agent — per-node install script
#
# Idempotent: run twice = same result. Installs the node-agent Docker image
# on this host, provisions its config, and (re)starts the container.
#
# Usage:
#   deploy/install-node-agent.sh          # install/reinstall on this host
#   deploy/install-node-agent.sh --help   # usage
#
# The node agent runs under host networking and listens on 30091. The
# dashboard (on another host) reaches it at <this-host-LAN-IP>:30091.
#
# Host access (actions build, agent ≥0.2.0):
#   The agent shells out to the host's docker / systemctl / nvidia-smi and
#   reads host devices, so the container mounts the docker socket, the three
#   host binaries, /run/systemd (systemctl's private socket — root-only,
#   which is why the container runs as root), and every /dev/nvidia* device.
#   /proc and /sys are already host-visible; no extra mount needed.
#
# Optional per-node env file (NOT mounted into the container, host-side):
#   ${HOME}/sparkdash-node-agent/agent.env  (suggested mode 600)
#   Any KEY=VALUE lines are exported to the container, e.g.
#     LLM_AUTH_TOKENS="8080:<sglang-api-key>"
#     NODE_AGENT_TOKEN="<bearer>"
#   Secrets stay out of the repo and out of the container's filesystem.

set -euo pipefail

IMAGE="airhamer/sparkdash-node-agent:latest"
CONTAINER="sparkdash-node-agent"
CONFIG_DIR="${HOME}/sparkdash-node-agent/config"
AGENT_PORT="30091"
ENV_FILE="${HOME}/sparkdash-node-agent/agent.env"

log()  { printf '[install-node-agent] %s\n' "$*"; }
err()  { printf '[install-node-agent] ERROR: %s\n' "$*" >&2; }

usage() {
  grep -E '^#( |$)' "$0" | sed -e 's/^#//' -e 's/^#//'
  exit 0
}

# ── 0. Args ────────────────────────────────────────────────────────────────
case "${1:-}" in
  -h|--help|help) usage ;;
  "") ;;
  *) err "unknown argument: $1 (try --help)"; exit 2 ;;
esac

# ── 1. Require docker (>= 20.0) ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found on PATH. Install Docker Engine >= 20.0 and re-run."
  exit 1
fi

docker_major="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1 || true)"
if [[ -z "${docker_major}" ]]; then
  err "could not read docker server version (is the daemon running? try: docker info)"
  exit 1
fi
if [[ "${docker_major}" -lt 20 ]]; then
  err "docker ${docker_major} is too old; need >= 20.0"
  exit 1
fi
log "docker $(docker version --format '{{.Client.Version}}') ok"

# ── 2. Resolve repo root (two levels up from this script) ─────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ── 3. Build the image ──────────────────────────────────────────────────────
log "building ${IMAGE} ..."
docker build -t "${IMAGE}" -f deploy/Dockerfile.node-agent .

# ── 4. Provision config (idempotent: never overwrite an existing recipes.json)
mkdir -p "${CONFIG_DIR}"
if [[ -f "${CONFIG_DIR}/recipes.json" ]]; then
  log "config dir ${CONFIG_DIR} already has recipes.json — leaving it untouched"
else
  cp agent/config/recipes.example.json "${CONFIG_DIR}/recipes.json"
  log "wrote ${CONFIG_DIR}/recipes.json (from recipes.example.json)"
fi

# ── 5. Optional per-node env file (host-side; not mounted) ─────────────────
ENV_ARGS=()
if [[ -f "${ENV_FILE}" ]]; then
  log "reading optional env file ${ENV_FILE} ..."
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  for k in LLM_AUTH_TOKENS NODE_AGENT_TOKEN NODE_ID NODE_NAME NODE_LAN_IP LLM_PORTS NODE_COMFY_PORT NODE_AGENT_AUDIT_PATH; do
    if [[ -n "${!k:-}" ]]; then
      ENV_ARGS+=("-e" "${k}=${!k}")
      # Never echo token values back to the log.
      log "env ${k} set (value hidden)"
    fi
  done
else
  log "no env file at ${ENV_FILE} — starting with defaults (LLM ports 8080)"
fi

# ── 6. Host-device detection (GPU) ─────────────────────────────────────────
DEVICE_ARGS=()
for dev in /dev/nvidiactl /dev/nvidia[0-9]*; do
  [[ -e "${dev}" ]] && DEVICE_ARGS+=("--device" "${dev}")
done
if [[ ${#DEVICE_ARGS[@]} -eq 0 ]]; then
  log "warning: no /dev/nvidia* devices found — GPU telemetry will be null on this host"
fi

# ── 7. (Re)start the container (idempotent: remove any existing one first) ─
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  log "stopping existing ${CONTAINER} ..."
  docker rm -f "${CONTAINER}" >/dev/null
fi

docker run -d \
  --name "${CONTAINER}" \
  --restart always \
  --network host \
  -v "${CONFIG_DIR}:/app/agent/config" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /usr/bin/docker:/usr/bin/docker:ro \
  -v /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro \
  -v /usr/bin/systemctl:/usr/bin/systemctl:ro \
  -v /run/systemd:/run/systemd \
  "${DEVICE_ARGS[@]}" \
  "${ENV_ARGS[@]}" \
  "${IMAGE}" >/dev/null

log "started ${CONTAINER}"

# ── 8. Verify /health + /telemetry ─────────────────────────────────────────
sleep 2
body="$(curl -s --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" || true)"
if [[ "${body}" == *'"ok":true'* ]]; then
  log "health ok: ${body}"
else
  err "health check returned unexpected body: ${body:-<empty>}"
  err "inspect with: docker logs ${CONTAINER}"
  exit 1
fi

telem="$(curl -s --max-time 15 "http://127.0.0.1:${AGENT_PORT}/telemetry" || true)"
gpu_null="$(printf '%s' "${telem}" | grep -c '"gpu":null' || true)"
containers_empty="$(printf '%s' "${telem}" | grep -c '"containers":\[\]' || true)"
if [[ "${gpu_null}" -eq 1 ]]; then
  log "warning: /telemetry reports gpu:null — check /dev/nvidia* + nvidia-smi on this host"
fi
if [[ "${containers_empty}" -eq 1 ]]; then
  log "warning: /telemetry reports no containers — check the docker socket mount"
fi
log "node-agent live on this host at 127.0.0.1:${AGENT_PORT}"
log "add this host to the dashboard's config/nodes.json (id, endpoint <lan-ip>:${AGENT_PORT})"
