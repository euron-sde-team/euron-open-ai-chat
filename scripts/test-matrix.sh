#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The API integration suite under every runtime option:
#
#   STORAGE              local  | s3            media on disk, or in S3 (Floci)
#   MAIL_MODE            outbox | smtp | ses    .eml files, SMTP to Mailpit, or SES
#                                               (Floci, relayed to Mailpit)
#
# The model providers, web search and moderation run against apps/stubs in every
# combination: the suite starts the stubs in-process on an ephemeral port and pins
# SEARCH_PROVIDER, MODERATION_PROVIDER and JOBS_MODE=inline itself
# (apps/api/test/integration/env.ts). 2 x 3 = 6 runs against the local stack
# (`make up` first: Postgres, Redis, Floci and Mailpit). Every row gets a fresh
# database whose name ends in _test and its own Redis logical database (1..6), so no
# state carries over.
# Exits non-zero if any combination fails; prints a table either way.
#
#   ONLY=s3            run only the rows whose label contains "s3"
#   FILTER=media       pass a file filter to vitest (only matching test files run)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PG_PORT="${CHAT_PG_PORT:-5502}"
REDIS_PORT="${CHAT_REDIS_PORT:-6439}"
FLOCI="http://localhost:${CHAT_FLOCI_PORT:-4607}"
SMTP_PORT="${CHAT_SMTP_PORT:-1056}"
export MAILPIT_URL="http://localhost:${CHAT_MAILPIT_PORT:-8056}"
ONLY="${ONLY:-}"
FILTER="${FILTER:-}"
# vitest directly: `pnpm test:integration -- <filter>` would not forward the filter.
vitest=(pnpm exec vitest run --config vitest.integration.config.mts)
[[ -n "$FILTER" ]] && vitest+=("$FILTER")

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

missing=()
listening "$PG_PORT" || missing+=("postgres :$PG_PORT")
listening "$REDIS_PORT" || missing+=("redis :$REDIS_PORT")
listening "$SMTP_PORT" || missing+=("mailpit smtp :$SMTP_PORT")
curl -s -o /dev/null "$FLOCI/" || missing+=("floci $FLOCI")
if ((${#missing[@]})); then
  printf 'Not reachable: %s\nStart the local stack first: make up\n' "${missing[*]}"
  exit 1
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

rows=()
failed=0
n=0
for storage in local s3; do
  for mail in outbox smtp ses; do
    n=$((n + 1))
    label="storage=$storage mail=$mail"
    [[ -n "$ONLY" && "$label" != *"$ONLY"* ]] && continue
    db="chat_matrix_$(printf '%02d' "$n")_test"
    redis-cli -p "$REDIS_PORT" -n "$n" FLUSHDB >/dev/null 2>&1 || true
    env_args=(
      TEST_DATABASE_URL="postgres://chat:chat@localhost:${PG_PORT}/${db}"
      TEST_REDIS_URL="redis://localhost:${REDIS_PORT}/${n}"
      STORAGE="$storage" MAIL_MODE="$mail"
      DATA_DIR="$tmp_root/$n"
    )
    if [[ "$storage" == s3 || "$mail" == ses ]]; then
      env_args+=(AWS_ENDPOINT_URL="$FLOCI" AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test)
    fi
    [[ "$storage" == s3 ]] && env_args+=(S3_BUCKET=open-chat-local-media S3_REGION=us-east-1 S3_PUBLIC_ENDPOINT="$FLOCI")
    [[ "$mail" != outbox ]] && env_args+=("MAIL_FROM=Euron Open AI Chat <no-reply@chat.example.test>")
    [[ "$mail" == smtp ]] && env_args+=(SMTP_HOST=localhost SMTP_PORT="$SMTP_PORT")
    [[ "$mail" == ses ]] && env_args+=(SES_REGION=us-east-1 SES_CONFIGURATION_SET=open-chat-local-mail)

    printf '%-46s ' "$label"
    out=$(env "${env_args[@]}" "${vitest[@]}" 2>&1)
    code=$?
    summary=$(grep -E '^\s+Tests ' <<<"$out" | tail -1 | sed -E 's/^\s+//')
    if [[ $code -ne 0 ]]; then
      failed=1
      status=FAIL
      echo "FAIL  ${summary:-no test summary}"
      grep -E 'FAIL|AssertionError|Error:' <<<"$out" | head -10 | sed 's/^/      /'
    else
      status=ok
      echo "ok    $summary"
    fi
    rows+=("$label|$status|${summary:-}")
  done
done

echo
printf '%-46s %-5s %s\n' "combination" "result" "tests"
printf '%-46s %-5s %s\n' "-----------" "------" "-----"
for row in "${rows[@]}"; do
  IFS='|' read -r label status summary <<<"$row"
  printf '%-46s %-6s %s\n' "$label" "$status" "$summary"
done
echo
if [[ $failed -eq 0 ]]; then
  echo "All ${#rows[@]} combinations passed."
else
  echo "Some combinations failed."
fi
exit $failed
