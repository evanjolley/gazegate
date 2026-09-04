#!/bin/bash
# GazeGate blocking daemon. Runs as root via launchd.
# GAZEGATE_DAEMON_VERSION=2
# Keeps /etc/hosts in sync with rules the (unprivileged) app writes as files.
# The app can NEVER edit /etc/hosts itself — only ask, via these files.
#
# Decision order each second:
#   1. now < unlock_until          -> ALLOW  (earned 60s-stare window; always wins)
#   2. Sunday and now >= sunday_block_until -> ALLOW  (Sunday is open by default)
#   3. Sunday and now <  sunday_block_until -> BLOCK  (user re-armed for the rest of today)
#   4. otherwise                   -> BLOCK

SUPPORT_DIR="__SUPPORT_DIR__"
UNLOCK_FILE="$SUPPORT_DIR/unlock_until"
SUNDAY_FILE="$SUPPORT_DIR/sunday_block_until"
SITES_FILE="$SUPPORT_DIR/sites.txt"
HOSTS="/etc/hosts"
START="# GAZEGATE-START"
END="# GAZEGATE-END"

DEFAULT_SITES="x.com www.x.com twitter.com www.twitter.com instagram.com www.instagram.com linkedin.com www.linkedin.com"

read_int() {
  local f="$1" d=0 v
  if [ -f "$f" ]; then
    v="$(cat "$f" 2>/dev/null | tr -cd '0-9')"
    [ -n "$v" ] && d="$v"
  fi
  echo "$d"
}

read_sites() {
  if [ -f "$SITES_FILE" ]; then
    grep -vE '^\s*(#|$)' "$SITES_FILE" | awk '{print $1}'
  else
    for s in $DEFAULT_SITES; do echo "$s"; done
  fi
}

base_hosts() {
  awk -v s="$START" -v e="$END" '
    $0==s {skip=1}
    skip==0 {print}
    $0==e {skip=0}
  ' "$HOSTS"
}

build_blocked() {
  base_hosts
  echo "$START"
  read_sites | while read -r site; do
    [ -n "$site" ] && echo "0.0.0.0 $site"
  done
  echo "$END"
}

apply() {
  local desired="$1" new current
  if [ "$desired" = "BLOCK" ]; then new="$(build_blocked)"; else new="$(base_hosts)"; fi
  current="$(cat "$HOSTS")"
  if [ "$new" != "$current" ]; then
    printf '%s\n' "$new" > "$HOSTS.gazegate.tmp"
    cat "$HOSTS.gazegate.tmp" > "$HOSTS"
    rm -f "$HOSTS.gazegate.tmp"
    dscacheutil -flushcache 2>/dev/null
    killall -HUP mDNSResponder 2>/dev/null
    echo "$(date '+%Y-%m-%d %H:%M:%S') applied $desired"
  fi
}

while true; do
  now="$(date +%s)"
  dow="$(date +%u)"                       # 7 = Sunday
  unlock_until="$(read_int "$UNLOCK_FILE")"
  sunday_block_until="$(read_int "$SUNDAY_FILE")"

  if [ "$now" -lt "$unlock_until" ]; then
    desired=ALLOW
  elif [ "$dow" = "7" ]; then
    if [ "$now" -lt "$sunday_block_until" ]; then desired=BLOCK; else desired=ALLOW; fi
  else
    desired=BLOCK
  fi

  apply "$desired"
  sleep 1
done
