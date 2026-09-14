#!/usr/bin/env bash
#
# bake-all.sh — run every outstanding sprite bake in sequence, unattended.
#
#   ./bake-all.sh                 # mobs, then items, then fringes
#   WAIT_MINS=30 ./bake-all.sh    # wait longer for ComfyUI to come up
#   RETRIES=5 ./bake-all.sh       # more attempts per pass
#   FORCE=1 ./bake-all.sh         # re-bake everything, ignoring description hashes
#
# Built to be walked away from: it waits for ComfyUI rather than failing at
# t=0, retries a pass that dies partway, and ends with a coverage report so you
# can see what actually landed without reading the whole log.
#
# Deliberately NOT `set -e`. A pass that fails is something to retry and then
# report on, not a reason to abandon the two passes behind it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

WAIT_MINS="${WAIT_MINS:-10}"
RETRIES="${RETRIES:-3}"
COMFY_URL="${COMFY_URL:-http://localhost:8188}"

# Where ComfyUI lives, so a crashed backend can be restarted mid-run. It sits
# beside the repo rather than inside it, and has its own venv (homebrew 3.14) —
# the system `python` is not the interpreter it runs under. Override either with
# an env var if you move it.
COMFY_DIR="${COMFY_DIR:-$(dirname "$ROOT")/ComfyUI}"
if [ -z "${COMFY_CMD:-}" ] && [ -f "$COMFY_DIR/main.py" ]; then
  if [ -x "$COMFY_DIR/env/bin/python" ]; then
    COMFY_CMD="./env/bin/python main.py --force-fp16"
  else
    COMFY_CMD="python main.py --force-fp16"
  fi
fi
COMFY_CMD="${COMFY_CMD:-}"
FORCE_FLAG=""
[ -n "${FORCE:-}" ] && FORCE_FLAG="--force"

mkdir -p "$HERE/logs"
LOG="$HERE/logs/bake-$(date +%Y%m%d-%H%M%S).log"
# Everything below is teed, so the terminal and the log agree.
exec > >(tee -a "$LOG") 2>&1

echo "=== sprite bake-all — $(date) ==="
echo "log: $LOG"
echo

# --- preflight -------------------------------------------------------------
# Each of these is a silent multi-hour waste if it's wrong, so fail loudly now.

if [ ! -x "$HERE/env/bin/python" ]; then
  echo "FATAL: no venv at sprites/env — see sprites/SETUP.md"
  exit 1
fi
# shellcheck disable=SC1091
source "$HERE/env/bin/activate"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  # The prompt builder calls Haiku once per subject; the key normally lives in
  # the repo .env rather than the shell.
  ANTHROPIC_API_KEY="$(grep -m1 '^ANTHROPIC_API_KEY=' "$ROOT/.env" | cut -d= -f2- | tr -d '"'"'"' ')"
  export ANTHROPIC_API_KEY
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL: ANTHROPIC_API_KEY not set and not found in $ROOT/.env"
  exit 1
fi

if [ ! -f "$HERE/workflow.json" ]; then
  echo "FATAL: no sprites/workflow.json — export one from ComfyUI (SETUP.md step 4)"
  exit 1
fi

# Wait rather than fail: the usual way this script gets run is "start ComfyUI,
# start this, leave", and the two race.
comfy_up() { curl -sf -m 5 -o /dev/null "$COMFY_URL/system_stats"; }

# Wait for ComfyUI, starting it first if it isn't up and we know how.
#
# The backend segfaulting mid-run is the normal failure here, not an exotic one:
# a long unattended queue on MPS died with SIGSEGV after ~21 generations on the
# first real run of this script, which cost the entire items and fringes passes.
# So every retry re-checks the backend and revives it rather than hammering a
# dead port.
ensure_comfy() {
  comfy_up && return 0

  if [ -n "$COMFY_CMD" ]; then
    echo "ComfyUI is down — restarting: $COMFY_CMD"
    ( cd "$COMFY_DIR" && nohup $COMFY_CMD > "$HERE/logs/comfyui.log" 2>&1 & )
  else
    echo "ComfyUI is down and COMFY_CMD is unset — waiting for you to start it"
  fi

  local deadline=$(( $(date +%s) + WAIT_MINS * 60 ))
  until comfy_up; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "ComfyUI did not come up within ${WAIT_MINS}m"
      return 1
    fi
    sleep 10
  done
  # It answers /system_stats before it can actually service a prompt; give the
  # model load a moment rather than burning an attempt on a half-open backend.
  sleep 20
  echo "ComfyUI is up."
}

if ! ensure_comfy; then
  echo "FATAL: no ComfyUI at $COMFY_URL. Set COMFY_DIR (and COMFY_CMD) or start it yourself."
  exit 1
fi
echo

# --- passes ----------------------------------------------------------------
# Retry whole passes instead of individual subjects: sprite_baker.py aborts the
# run on the first exception, but saves its manifest after every success, so a
# re-run hash-skips everything already done and picks up where it died. Cheap
# to retry, and it needs no changes to the baker.

run_pass() {
  local kind="$1" manifest="$2" label="$3"
  echo "--- $label ---"
  for attempt in $(seq 1 "$RETRIES"); do
    echo "[attempt $attempt/$RETRIES] $(date +%H:%M:%S)"
    if ! ensure_comfy; then
      echo "[$label] backend unavailable — giving up on this pass"
      return 1
    fi
    # -u because stdout here is a pipe (tee), not a tty: without it Python
    # buffers in 4KB blocks and a tail -f of a running bake shows nothing for
    # minutes at a time, which is indistinguishable from a hang.
    if python -u "$HERE/sprite_baker.py" --kind "$kind" "$HERE/$manifest" $FORCE_FLAG; then
      echo "[$label] pass completed"
      return 0
    fi
    echo "[$label] attempt $attempt failed; re-running to resume from the manifest"
    sleep 15
  done
  echo "[$label] STILL FAILING after $RETRIES attempts — see the report below"
  return 1
}

run_pass mob    mobs.json    "mobs (5 shopkeepers + torch_01)"
echo
run_pass item   items.json   "items (51 icons)"
echo
run_pass fringe fringes.json "fringes (5 material rims)"
echo

# --- promote mob art -------------------------------------------------------
# KINDS['mob'] writes to sprites/out/ (the atlas source), but the client loads
# mobs per-id from /sprites/<id>.png. Without this copy a baked mob is invisible
# in game. Items and fringes already bake straight to their client dirs.

# Driven off mobs.json rather than a glob of out/: that directory also holds
# older experiments (skeleton_warrior from mobs_sample.json, marsh_heron,
# rot_blob) that no mob references, and a blanket copy would quietly ship them.
echo "--- promoting mob art to client/public/sprites/ ---"
promoted=0
while IFS= read -r name; do
  src="$HERE/out/$name.png"
  [ -f "$src" ] || continue
  if ! cmp -s "$src" "$ROOT/client/public/sprites/$name.png"; then
    cp "$src" "$ROOT/client/public/sprites/$name.png"
    echo "  promoted $name.png"
    promoted=$((promoted + 1))
  fi
done < <(python -c "
import json, sys
for e in json.load(open('$HERE/mobs.json')): print(e['id'])
")
[ "$promoted" -eq 0 ] && echo "  nothing to promote (all current)"
echo

# --- coverage report -------------------------------------------------------
# The point of the whole script: come back to this, not to 2000 lines of poll
# output. Expected ids come from the manifests, so this can't drift from them.

echo "=== coverage report — $(date) ==="
python - "$ROOT" <<'PY'
import json, os, sys

root = sys.argv[1]
sprites = os.path.join(root, "sprites")
checks = [
    ("mobs",    "mobs.json",    os.path.join(root, "client/public/sprites")),
    ("items",   "items.json",   os.path.join(root, "client/public/sprites")),
    ("fringes", "fringes.json", os.path.join(root, "client/public/tiles")),
    ("tiles",   "tiles.json",   os.path.join(root, "client/public/tiles")),
]

total_missing = 0
for label, manifest, out_dir in checks:
    ids = [e["id"] for e in json.load(open(os.path.join(sprites, manifest)))]
    missing = [i for i in ids if not os.path.exists(os.path.join(out_dir, f"{i}.png"))]
    total_missing += len(missing)
    print(f"  {label:9} {len(ids) - len(missing):3}/{len(ids):3} on disk")
    for m in missing:
        print(f"      MISSING  {m}")

print()
print("all subjects baked." if not total_missing
      else f"{total_missing} still missing — re-run this script to retry just those.")
PY

echo
echo "log: $LOG"
