#!/bin/bash
# GazeGate blocking daemon. Runs as root via launchd.
# GAZEGATE_DAEMON_VERSION=3
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

# Always blocked, unioned in on top of whatever sites.txt holds. Deleting them
# from sites.txt (or deleting the file) does not unblock them.
CORE_SITES="x.com www.x.com twitter.com www.twitter.com instagram.com www.instagram.com linkedin.com www.linkedin.com"

read_int() {
  local f="$1" d=0 v
  if [ -f "$f" ]; then
    v="$(cat "$f" 2>/dev/null | tr -cd '0-9')"
    [ -n "$v" ] && d="$v"
  fi
  echo "$d"
}

read_sites() {
  {
    for s in $CORE_SITES; do echo "$s"; done
    [ -f "$SITES_FILE" ] && grep -vE '^[[:space:]]*(#|$)' "$SITES_FILE" | awk '{print tolower($1)}'
  } | awk 'NF && !seen[$0]++'
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
