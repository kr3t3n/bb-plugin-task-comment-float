#!/usr/bin/env bash
# Focused smoke for TPRO-3 env-aware dispatch.
#
# Two modes:
#   ./scripts/smoke-env-dispatch.sh
#       Safe mode. Exercises env discovery, profile CRUD, and every dispatch
#       input-validation path. Spawns no agents.
#   ./scripts/smoke-env-dispatch.sh --spawn <TASK-KEY> [--preset <name>]
#       Also dispatches the task once per target kind: preset, path, reuse.
#       This starts three real agent threads. Use a scratch task, and set
#       TPRO3_SMOKE_PATH to a scratch checkout — the default lands an agent in
#       this plugin's own source tree.
#
# The script needs a running bb daemon with Tasks and Tasks Pro enabled.
set -uo pipefail

BB="${BB_CLI:-bb}"
SMOKE_PROFILE="tpro3-smoke"
SMOKE_PATH="${TPRO3_SMOKE_PATH:-/home/bb/plugins/bb-plugin-task-comment-float}"

SPAWN=0
TASK_KEY=""
PRESET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spawn) SPAWN=1; TASK_KEY="${2:-}"; shift 2 ;;
    --preset) PRESET="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

pass=0
fail=0

ok() { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# Run a command and check its exit code and, optionally, a stdout/stderr match.
expect() {
  local label="$1" want_code="$2" want_match="$3"; shift 3
  local out code
  out="$("$@" 2>&1)"
  code=$?
  if [ "$code" -ne "$want_code" ]; then
    bad "$label (exit $code, wanted $want_code)"
    printf '        %s\n' "$out"
    return
  fi
  if [ -n "$want_match" ] && ! printf '%s' "$out" | grep -qi -- "$want_match"; then
    bad "$label (output missing “$want_match”)"
    printf '        %s\n' "$out"
    return
  fi
  ok "$label"
}

# Print the id of the first ready environment in `envs [--project <id>]`.
first_ready_env() {
  local project_args=()
  [ -n "${1:-}" ] && project_args=(--project "$1")
  "$BB" tasks-pro envs "${project_args[@]}" --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    rows = json.load(sys.stdin).get("environments", [])
except Exception:
    rows = []
ready = [r for r in rows if r.get("status") == "ready"]
print(ready[0]["id"] if ready else "")'
}

echo "== environment discovery =="
expect "envs --json lists environments" 0 '"ok":true' \
  "$BB" tasks-pro envs --json

ANY_ENV="$(first_ready_env)"
if [ -n "$ANY_ENV" ]; then
  ok "envs lists at least one ready environment ($ANY_ENV)"
else
  bad "no ready environment found"
fi

echo
echo "== profile CRUD =="
"$BB" tasks-pro env-profile-rm "$SMOKE_PROFILE" >/dev/null 2>&1

expect "create a path profile" 0 "Saved env profile" \
  "$BB" tasks-pro env-profile-set "$SMOKE_PROFILE" --path "$SMOKE_PATH"
expect "profile appears in the list" 0 "$SMOKE_PROFILE" \
  "$BB" tasks-pro env-profiles
expect "update the same profile with a branch" 0 "Saved env profile" \
  "$BB" tasks-pro env-profile-set "$SMOKE_PROFILE" --path "$SMOKE_PATH" --branch main
expect "reject a profile with neither --env-id nor --path" 1 "exactly one" \
  "$BB" tasks-pro env-profile-set "$SMOKE_PROFILE"
expect "reject a profile with both --env-id and --path" 1 "exactly one" \
  "$BB" tasks-pro env-profile-set "$SMOKE_PROFILE" --env-id env_x --path /tmp
expect "reject a relative profile path" 1 "absolute" \
  "$BB" tasks-pro env-profile-set "${SMOKE_PROFILE}-rel" --path relative/dir

echo
echo "== dispatch input validation (no agent spawned) =="
expect "reject --env-id together with --path" 1 "at most one" \
  "$BB" tasks-pro dispatch SMOKE-0 --env-id env_x --path /tmp
expect "reject --branch without --path" 1 "only applies with --path" \
  "$BB" tasks-pro dispatch SMOKE-0 --branch main
expect "reject a relative --path" 1 "absolute" \
  "$BB" tasks-pro dispatch SMOKE-0 --path relative/dir
expect "reject an unknown --profile" 1 "No env profile" \
  "$BB" tasks-pro dispatch SMOKE-0 --profile no-such-profile

echo
echo "== cleanup =="
expect "delete the smoke profile" 0 "Removed env profile" \
  "$BB" tasks-pro env-profile-rm "$SMOKE_PROFILE"
expect "deleting it twice reports a miss" 1 "No env profile" \
  "$BB" tasks-pro env-profile-rm "$SMOKE_PROFILE"

if [ "$SPAWN" -eq 1 ]; then
  if [ -z "$TASK_KEY" ]; then
    echo "--spawn needs a task key." >&2
    exit 2
  fi
  preset_args=()
  [ -n "$PRESET" ] && preset_args=(--preset "$PRESET")

  BB_PROJECT="$("$BB" tasks-pro show "$TASK_KEY" --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
print((data.get("project") or {}).get("linkedBbProjectId") or "")')"

  echo
  echo "== live dispatch on $TASK_KEY (three agent threads) =="
  if [ -n "$BB_PROJECT" ]; then
    ok "task links bb project $BB_PROJECT"
  else
    bad "task has no linked bb project — explicit targets cannot work"
  fi

  expect "kind preset  → Tasks delegate" 0 '"via":"delegate"' \
    "$BB" tasks-pro dispatch "$TASK_KEY" "${preset_args[@]}" --json

  # Run the path kind before the reuse kind: it creates an unmanaged
  # environment inside the task's bb project, which reuse can then target.
  expect "kind path    → spawn on $SMOKE_PATH" 0 '"via":"spawn"' \
    "$BB" tasks-pro dispatch "$TASK_KEY" "${preset_args[@]}" --path "$SMOKE_PATH" --json

  SAME_ENV="$(first_ready_env "$BB_PROJECT")"
  if [ -n "$SAME_ENV" ]; then
    expect "kind reuse   → spawn on $SAME_ENV" 0 '"via":"spawn"' \
      "$BB" tasks-pro dispatch "$TASK_KEY" "${preset_args[@]}" --env-id "$SAME_ENV" --json
  else
    bad "kind reuse skipped — no ready environment in $BB_PROJECT"
  fi

  # bb rejects a reuse target owned by another bb project. Nothing spawns.
  OTHER_ENV="$(python3 -c 'import json,subprocess,sys
bb, project = sys.argv[1], sys.argv[2]

def ids(args):
    try:
        out = subprocess.run([bb, "tasks-pro", "envs", *args, "--json"],
                             capture_output=True, text=True).stdout
        rows = json.loads(out).get("environments", [])
    except Exception:
        return []
    return [r["id"] for r in rows if r.get("status") == "ready"]

mine = set(ids(["--project", project])) if project else set()
print(next((i for i in ids([]) if i not in mine), ""))' "$BB" "$BB_PROJECT")"
  if [ -n "$OTHER_ENV" ]; then
    expect "reuse across bb projects is refused" 1 "different project" \
      "$BB" tasks-pro dispatch "$TASK_KEY" "${preset_args[@]}" --env-id "$OTHER_ENV" --json
  else
    ok "no cross-project environment available — check skipped"
  fi
fi

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
