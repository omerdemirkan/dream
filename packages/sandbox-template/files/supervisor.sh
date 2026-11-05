#!/bin/bash
# The template's start command. It keeps dreamd running for the life of the
# sandbox: E2B starts it when the template is built, and the sandbox snapshot
# keeps it running in every sandbox made from the template, across pauses.
# dreamd waits for the env file the ProjectDO writes, and exits when the file
# changes or it crashes; either way it's started again here.
set -u
source /opt/dream/sandbox/env.sh
echo $$ > /tmp/dream-supervisor.pid
mkdir -p "$DREAM_LOG_DIR"
log="$DREAM_LOG_DIR/dreamd.log"
failures=0
while true; do
  if [ -f "$log" ] && [ "$(stat -c %s "$log")" -gt 52428800 ]; then mv -f "$log" "$log.1"; fi
  started=$(date +%s)
  /usr/local/bin/dreamd >> "$log" 2>&1
  code=$?
  # Back off if it keeps dying quickly; a long run resets the count.
  if [ $(( $(date +%s) - started )) -gt 60 ]; then failures=0; else failures=$(( failures + 1 )); fi
  delay=$(( failures < 5 ? 1 << failures : 30 ))
  echo "$(date -u +%FT%TZ) supervisor: dreamd exited with $code; starting it again in ${delay}s" >> "$log"
  sleep "$delay"
done
