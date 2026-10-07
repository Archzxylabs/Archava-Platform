#!/usr/bin/env bash
set -euo pipefail

pids=()
cleanup() {
  trap - SIGTERM SIGINT
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap 'cleanup; exit 0' SIGTERM SIGINT

case "${RUN_MODE:-all}" in
  all)
    python3 backend/agent.py start & pids+=("$!")
    node server/index.mjs & pids+=("$!")
    ;;
  api) exec node server/index.mjs ;;
  worker) exec python3 backend/agent.py start ;;
  *) echo "RUN_MODE must be all, api, or worker" >&2; exit 2 ;;
esac

# Disable errexit around wait: preserve a failing child's status and stop its sibling.
set +e
wait -n "${pids[@]}"
status=$?
set -e
cleanup
# A service exiting unexpectedly, even cleanly, must trigger the restart policy.
if [ "$status" -eq 0 ]; then status=1; fi
exit "$status"
