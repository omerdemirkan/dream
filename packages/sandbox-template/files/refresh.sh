#!/bin/bash
# Swaps a sandbox onto a newer template build's Dream: /opt/dream (dreamd, the
# `dream` CLI, the prompt and skill, the supervisor) and the harness bridges
# with their Claude Code and Codex CLIs (~/.ai-sdk-harness/.harness-bootstrap).
# The ProjectDO copies both from a fresh sandbox of the latest build into
# <dir>.next, then runs this script from the new copy, as root, between turns:
#
#   refresh.sh activate   check the staged copy runs, stop dreamd and its
#                         supervisor, swap the copies (keeping the old ones as
#                         <dir>.prev), and start the new supervisor
#   refresh.sh rollback   put back whatever activate swapped, and start the old
#                         supervisor (after a failed activate, or a new dreamd
#                         that doesn't answer)
#   refresh.sh commit     the new dreamd answered: drop the .prev copies
#
# Nothing else is touched: the project, ~/.dream (dreamd's inbox, session and
# env file), ~/.claude and ~/.codex (the harness conversations), and the
# harnesses' per-session state in ~/.ai-sdk-harness/.agent-runs all stay, and
# so do processes outside dreamd's tree (the apps the agent runs).
#
# ROOT (default /) relocates every path, for tests.
set -euo pipefail

root=${ROOT:-}
dream=$root/opt/dream
harness=$root/home/user/.ai-sdk-harness/.harness-bootstrap
bin=$root/usr/local/bin
pidfile=$root/tmp/dream-supervisor.pid
run_as=${REFRESH_USER:-user}
# What dreamd's and the bridges' command lines contain.
dreamd_pattern="$root/opt/dream[^ ]*/src/bin/dreamd\\.ts"
bridges_pattern="$root/home/user/\\.ai-sdk-harness/\\.harness-bootstrap"

log() { echo "refresh: $*"; }

as_user() {
  if [ "$(id -un)" = "$run_as" ]; then "$@"; else runuser -u "$run_as" -- "$@"; fi
}

# The staged (or given) copy's CLIs and dreamd load.
check() {
  local tree=$1 bridges=$2
  as_user node --disable-warning=ExperimentalWarning "$tree/packages/dreamd/src/bin/dream.ts" --help > /dev/null
  as_user "$bridges/claude-code/node_modules/.bin/claude" --version
  as_user "$bridges/codex/node_modules/.bin/codex" --version
  ls "$bridges"/claude-code/.bootstrap-*.ok "$bridges"/codex/.bootstrap-*.ok > /dev/null
}

# The supervisor's environment, as E2B started it, so the new one gets the same.
# Saved on the way, in case the supervisor is gone by the time it's needed.
envfile=$root/tmp/dream-supervisor.env
supervisor_env=()
save_supervisor_env() {
  local pid
  pid=$(cat "$pidfile" 2> /dev/null || true)
  if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
    mapfile -d '' supervisor_env < "/proc/$pid/environ"
    cp "/proc/$pid/environ" "$envfile"
  elif [ -s "$envfile" ]; then
    mapfile -d '' supervisor_env < "$envfile"
  fi
  if [ ${#supervisor_env[@]} -eq 0 ]; then supervisor_env=("HOME=/home/$run_as" "USER=$run_as" "PATH=/usr/local/bin:/usr/bin:/bin"); fi
}

# Stops the supervisor first (so it doesn't start dreamd again), then dreamd,
# which stops the bridges and CLIs it started, then anything still running
# from the harness bootstrap (a bridge left behind would be reattached to).
stop_dreamd() {
  local pid
  pid=$(cat "$pidfile" 2> /dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then kill -TERM "$pid" 2> /dev/null || true; fi
  pkill -TERM -f "$dreamd_pattern" 2> /dev/null || true
  for _ in $(seq 1 40); do
    pgrep -f "$dreamd_pattern" > /dev/null || break
    sleep 0.5
  done
  pkill -KILL -f "$dreamd_pattern" 2> /dev/null || true
  if pgrep -f "$bridges_pattern" > /dev/null; then
    pkill -TERM -f "$bridges_pattern" 2> /dev/null || true
    sleep 1
    pkill -KILL -f "$bridges_pattern" 2> /dev/null || true
  fi
  rm -f "$pidfile"
}

# The commands on PATH point into /opt/dream; install them from the current copy.
install_bin() {
  install -m 755 "$dream/sandbox/dream" "$dream/sandbox/dreamd" "$bin/"
  if [ -f "$dream/sandbox/chromium" ]; then
    install -m 755 "$dream/sandbox/chromium" "$bin/"
    ln -sf chromium "$bin/chrome"
  fi
}

start_supervisor() {
  chmod 755 "$dream/sandbox/supervisor.sh"
  # In a session of its own, so it outlives this script and whatever runs it.
  if [ "$(id -un)" = "$run_as" ]; then
    setsid -f env -i "${supervisor_env[@]}" "$dream/sandbox/supervisor.sh" < /dev/null > /dev/null 2>&1
  else
    setsid -f runuser -u "$run_as" -- env -i "${supervisor_env[@]}" "$dream/sandbox/supervisor.sh" < /dev/null > /dev/null 2>&1
  fi
  for _ in $(seq 1 40); do
    [ -f "$pidfile" ] && return 0
    sleep 0.25
  done
  log "the supervisor didn't start"
  return 1
}

swap() {
  local from=$1 to=$2
  rm -rf "$to"
  mv "$from" "$to"
}

case "${1:-}" in
  activate)
    [ -d "$dream.next" ] && [ -d "$harness.next" ] || { log "nothing staged"; exit 1; }
    check "$dream.next" "$harness.next"
    save_supervisor_env
    stop_dreamd
    swap "$dream" "$dream.prev"
    swap "$dream.next" "$dream"
    if [ -d "$harness" ]; then swap "$harness" "$harness.prev"; fi
    swap "$harness.next" "$harness"
    install_bin
    start_supervisor
    log "activated $(cat "$dream/release.json" 2> /dev/null || echo 'an unknown release')"
    ;;
  rollback)
    # Undoes a failed or partial activate: whatever was swapped goes back, and
    # the old supervisor starts again.
    save_supervisor_env
    stop_dreamd
    rm -rf "$dream.next" "$harness.next"
    if [ -d "$dream.prev" ]; then
      if [ -d "$dream" ]; then swap "$dream" "$dream.failed"; fi
      swap "$dream.prev" "$dream"
    fi
    if [ -d "$harness.prev" ]; then
      if [ -d "$harness" ]; then swap "$harness" "$harness.failed"; fi
      swap "$harness.prev" "$harness"
    fi
    install_bin
    start_supervisor
    rm -rf "$dream.failed" "$harness.failed"
    log "rolled back"
    ;;
  commit)
    rm -rf "$dream.prev" "$harness.prev" "$dream.next" "$harness.next"
    log "committed"
    ;;
  *)
    echo "usage: refresh.sh activate|rollback|commit" >&2
    exit 2
    ;;
esac
