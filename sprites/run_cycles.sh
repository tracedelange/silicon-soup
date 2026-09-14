#!/usr/bin/env bash
#
# run_cycles.sh — run style_lab cycles unattended, in order.
#
#   ./run_cycles.sh                      # every cycle, in order
#   ./run_cycles.sh c3_chunky c4_flatcel # just these
#
# Separate from bake-all.sh on purpose: that one bakes the real world's art
# into client/, this one only ever writes under sprites/experiments/. Mixing
# them risks an experiment landing in the game.
#
# Not `set -e`. A cycle that dies is a cycle to report on, not a reason to
# abandon the ones behind it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
COMFY_URL="${COMFY_URL:-http://localhost:8188}"
COMFY_DIR="${COMFY_DIR:-$(dirname "$ROOT")/ComfyUI}"

CYCLES=("$@")
[ ${#CYCLES[@]} -eq 0 ] && CYCLES=(c1_control c2_palette c3_chunky c4_flatcel c5_painted)

mkdir -p "$HERE/logs"
LOG="$HERE/logs/cycles-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "=== style cycles — $(date) ==="
echo "log: $LOG"
echo "cycles: ${CYCLES[*]}"
echo

source "$HERE/env/bin/activate"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
[ -z "${ANTHROPIC_API_KEY:-}" ] && { echo "FATAL: no ANTHROPIC_API_KEY"; exit 1; }

comfy_up() { curl -sf -m 5 -o /dev/null "$COMFY_URL/system_stats"; }

# The backend segfaulting partway through a long MPS queue is the normal
# failure mode here, so revive it between cycles rather than failing the run.
ensure_comfy() {
  comfy_up && return 0
  echo "ComfyUI down — restarting"
  ( cd "$COMFY_DIR" && nohup ./env/bin/python main.py --force-fp16 \
      > "$HERE/logs/comfyui.log" 2>&1 & )
  local deadline=$(( $(date +%s) + 600 ))
  until comfy_up; do
    [ "$(date +%s)" -ge "$deadline" ] && { echo "ComfyUI never came up"; return 1; }
    sleep 10
  done
  sleep 20   # answers /system_stats before it can service a prompt
  echo "ComfyUI is up."
}

for cyc in "${CYCLES[@]}"; do
  echo "============================================================"
  echo "CYCLE $cyc — $(date +%H:%M:%S)"
  echo "============================================================"
  ensure_comfy || { echo "[$cyc] no backend, skipping"; continue; }
  # -u so a tail -f of the log shows progress; without it Python blocks in 4KB
  # chunks and a running cycle is indistinguishable from a hung one.
  python -u "$HERE/style_lab.py" bake "$cyc"
  echo "[$cyc] exit=$?  $(date +%H:%M:%S)"
  echo
done

echo "=== building comparison sheet ==="
python -u "$HERE/style_lab.py" sheet
echo
echo "=== done $(date) ==="
echo "log: $LOG"
