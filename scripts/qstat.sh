#!/bin/bash
# Prints the PBS queue of the remote user on an ssh host, for the Project pane:
#   bash qstat.sh user@login.cluster.example
# First line NOCONNECTION when the host can't be reached without a password (no shared
# ControlMaster connection and no key), else qstat's output, then one "ARRAY <id> S=n ..."
# line per array job, then "EXIT <code>".
H="$1"
if [ -z "$H" ]; then
  echo NOCONNECTION
  exit 0
fi
if ! ssh -O check "$H" >/dev/null 2>&1 && ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$H" true >/dev/null 2>&1; then
  echo NOCONNECTION
  exit 0
fi
ssh -o BatchMode=yes -o ConnectTimeout=15 "$H" 'bash -l -s' <<'REMOTE'
qstat -w -u "$USER" 2>&1
for id in $(qstat -w -u "$USER" 2>/dev/null | awk '$1 ~ /\[\]/ {print $1}'); do
  counts=$(qstat -t -w "$id" 2>/dev/null | awk '$1 ~ /\[[0-9]+\]/ {c[$10]++} END {for (s in c) printf "%s=%d ", s, c[s]}')
  echo "ARRAY $id $counts"
done
REMOTE
echo "EXIT $?"
