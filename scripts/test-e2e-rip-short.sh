#!/bin/bash
# Test end-to-end: dispara un rip CORTO (5 escenas) y monitorea hasta completar.
# Verifica que VALIDATOR CHAT IA (internal chat) se dispare en cada escena.
#
# Uso:
#   bash scripts/test-e2e-rip-short.sh

set -e

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BASE_URL="http://localhost:3000"
PASSWORD=$(grep ^APP_PASSWORD= .env | cut -d= -f2-)
COOKIE_JAR="$ROOT/.cookie-jar-e2e"
rm -f "$COOKIE_JAR"

echo "════════════════════════════════════════════════════════════════"
echo "  TEST E2E — VALIDATOR CHAT IA en pipeline REAL"
echo "════════════════════════════════════════════════════════════════"
echo

# 1. Login
echo "[1/5] Login..."
curl -s -c "$COOKIE_JAR" -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" \
  "$BASE_URL/api/auth" | head -1
echo

# 2. Trigger generate con script corto (~25s = 5-6 scenes esperadas)
echo "[2/5] Triggering rip..."
SCRIPT_TEXT="Sabías que el 80 por ciento de las pastillas se desperdician antes de llegar al cuerpo. Las gotas sublinguales se absorben directo bajo la lengua, evitando el sistema digestivo. Una sola gota debajo de la lengua, en treinta segundos los nutrientes ya circulan en la sangre. Vitaly Gotas, probá la diferencia. Encontranos en vitaly punto com."

RESP=$(curl -s -b "$COOKIE_JAR" -H "Content-Type: application/json" \
  -d "{
    \"brandId\": \"vitaly\",
    \"presetId\": \"mujer_protagonista_broll_animado_comic_sepia\",
    \"productId\": \"vitaly_gotas\",
    \"script\": \"$SCRIPT_TEXT\"
  }" \
  "$BASE_URL/api/generate")

echo "Response: $RESP"
RUN_ID=$(echo "$RESP" | grep -oE '"runId":"[^"]+"' | cut -d'"' -f4)

if [ -z "$RUN_ID" ]; then
  echo "❌ ERROR: no se pudo extraer runId"
  exit 1
fi

echo "✓ runId = $RUN_ID"
echo

# 3. Poll status hasta completar
echo "[3/5] Polling status (timeout 30 min)..."
START=$(date +%s)
TIMEOUT=$((30 * 60))
LAST_PROGRESS=-1
LAST_STEP=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))
  if [ $ELAPSED -gt $TIMEOUT ]; then
    echo "❌ TIMEOUT después de ${ELAPSED}s"
    break
  fi

  STATUS_JSON=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/runs/$RUN_ID")
  STATUS=$(echo "$STATUS_JSON" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
  PROGRESS=$(echo "$STATUS_JSON" | grep -oE '"progress":[0-9]+' | head -1 | cut -d: -f2)
  STEP=$(echo "$STATUS_JSON" | grep -oE '"currentStep":"[^"]+"' | head -1 | cut -d'"' -f4)

  if [ "$PROGRESS" != "$LAST_PROGRESS" ] || [ "$STEP" != "$LAST_STEP" ]; then
    printf "  [%4ds] status=%-10s progress=%3s%% step=%s\n" "$ELAPSED" "$STATUS" "$PROGRESS" "$STEP"
    LAST_PROGRESS="$PROGRESS"
    LAST_STEP="$STEP"
  fi

  if [ "$STATUS" = "completed" ]; then
    echo "✅ COMPLETED en ${ELAPSED}s"
    break
  fi
  if [ "$STATUS" = "failed" ]; then
    echo "❌ FAILED en ${ELAPSED}s"
    ERR=$(echo "$STATUS_JSON" | grep -oE '"errorMessage":"[^"]+"' | head -1 | cut -d'"' -f4)
    echo "Error: $ERR"
    break
  fi

  sleep 15
done

# 4. Validator history
echo
echo "[4/5] Validator history..."
VAL_HIST=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/runs/$RUN_ID/validator-history")
TOTAL_ENTRIES=$(echo "$VAL_HIST" | grep -oE '"totalEntries":[0-9]+' | head -1 | cut -d: -f2)
SCENES_EVAL=$(echo "$VAL_HIST" | grep -oE '"scenesEvaluated":[0-9]+' | head -1 | cut -d: -f2)
SCENES_APP=$(echo "$VAL_HIST" | grep -oE '"scenesApproved":[0-9]+' | head -1 | cut -d: -f2)
SCENES_REJ=$(echo "$VAL_HIST" | grep -oE '"scenesRejected":[0-9]+' | head -1 | cut -d: -f2)

echo "  totalEntries:    $TOTAL_ENTRIES"
echo "  scenesEvaluated: $SCENES_EVAL"
echo "  scenesApproved:  $SCENES_APP"
echo "  scenesRejected:  $SCENES_REJ"
echo

# 5. Listing of persisted artifacts
echo "[5/5] Artifacts persistidos:"
ls -la "$ROOT/storage/validator-chat-ia/$RUN_ID/" 2>/dev/null | head -20 || echo "  (no dir todavía)"

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Test E2E completado. runId: $RUN_ID"
echo "════════════════════════════════════════════════════════════════"
rm -f "$COOKIE_JAR"
