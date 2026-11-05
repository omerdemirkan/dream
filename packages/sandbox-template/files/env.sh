# The environment dreamd (and so the agent, and every app it starts) runs in.
# Sourced by the supervisor and by login shells.
export HOME=/home/user
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:$HOME/.local/bin
export DREAM_LOG_DIR=$HOME/.dream/logs
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
export LANG=C.UTF-8
