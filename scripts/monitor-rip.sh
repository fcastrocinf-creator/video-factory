#!/bin/bash
# Monitorea un rip ya disparado. Polls cada 20s y reporta status.
RUN_ID="${1:-49019ac4-2cef-4d5e-84e1-326bac7462c1}"
cd "$(dirname "$0")/.."

PASSWORD=$(grep ^APP_PASSWORD= .env | cut -d= -f2-)
COOKIE_JAR="/tmp/cj-monitor-$$"
trap "rm -f $COOKIE_JAR" EXIT

# Login (silent)
curl -s -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" \
  "http://localhost:3000/api/auth" > /dev/null

START=$(date +%s)
LAST_STATUS=""
LAST_STEP=""
LAST_PROGRESS=-1

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  if [ $ELAPSED -gt 1800 ]; then
    echo "[$(date +%H:%M:%S)] TIMEOUT @30min"
    break
  fi

  STATUS_JSON=$(curl -s -b "$COOKIE_JAR" "http://localhost:3000/api/runs/$RUN_ID")
  STATUS=$(echo "$STATUS_JSON" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
  PROGRESS=$(echo "$STATUS_JSON" | grep -oE '"progress":[0-9]+' | head -1 | cut -d: -f2)
  STEP=$(echo "$STATUS_JSON" | grep -oE '"currentStep":"[^"]+"' | head -1 | cut -d'"' -f4)

  if [ "$STATUS" != "$LAST_STATUS" ] || [ "$STEP" != "$LAST_STEP" ] || [ "$PROGRESS" != "$LAST_PROGRESS" ]; then
    printf "[%s @%4ds] status=%-10s progress=%3s%% step=%s\n" \
      "$(date +%H:%M:%S)" "$ELAPSED" "$STATUS" "$PROGRESS" "$STEP"
    LAST_STATUS="$STATUS"; LAST_STEP="$STEP"; LAST_PROGRESS="$PROGRESS"
  fi

  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "[$(date +%H:%M:%S)] FINAL: $STATUS @ ${ELAPSED}s"
    if [ "$STATUS" = "failed" ]; then
      echo "$STATUS_JSON" | grep -oE '"errorMessage":"[^"]+"'
    fi
    break
  fi

  sleep 20
done
