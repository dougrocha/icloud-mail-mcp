#!/bin/bash
set -euo pipefail
BASE=${BASE:-https://localhost:8787}
export CURL_CA_BUNDLE="$(mkcert -CAROOT)/rootCA.pem"
RES=$BASE/mcp
REDIR=http://localhost:9999/cb
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 path/to/.dev.vars" >&2; exit 2; }
VARS="$1"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
# Strip optional surrounding quotes, as wrangler does for .dev.vars values.
PASS=$(grep '^AUTH_PASSPHRASE=' "$VARS" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')

mint_token() {
  MINTED_REFRESH=
  local VER CH Q HANDLE LOC CODE TOKRESP c
  MINTED_CID=$(curl -sf -X POST $BASE/oauth/register -H 'Content-Type: application/json' \
    -d "{\"client_name\":\"cli-test\",\"redirect_uris\":[\"$REDIR\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}" | jq -r .client_id)
  VER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
  CH=$(printf %s "$VER" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=\n')
  Q="response_type=code&client_id=$(jq -rn --arg v "$MINTED_CID" '$v|@uri')&redirect_uri=$(jq -rn --arg v "$REDIR" '$v|@uri')&code_challenge=$CH&code_challenge_method=S256&scope=mail%3Aread&state=xyz&resource=$(jq -rn --arg v "$RES" '$v|@uri')"
  : >"$W/jar"
  curl -sf -c "$W/jar" "$BASE/authorize?$Q" -o "$W/consent.html"
  HANDLE=$(grep -o 'name="handle" value="[^"]*"' "$W/consent.html" | sed 's/.*value="//;s/"$//')
  echo "consent page: $(grep -o '<h2>[^<]*' "$W/consent.html" | sed 's/<h2>//')"
  echo "  checkboxes: $(grep -o 'name="cap" value="[a-z]*"' "$W/consent.html" | sed 's/.*value=//' | tr -d '"' | tr '\n' ' ')"
  local args=(--data-urlencode "handle=$HANDLE" --data-urlencode "passphrase=$PASS" --data-urlencode "decision=approve")
  for c in "$@"; do args+=(--data-urlencode "cap=$c"); done
  LOC=$(curl -s -b "$W/jar" -c "$W/jar" -o /dev/null -w '%{redirect_url}' -X POST "$BASE/authorize?$Q" "${args[@]}")
  CODE=$(printf %s "$LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p' | perl -pe 's/%([0-9A-Fa-f]{2})/chr hex $1/ge')
  [ -n "$CODE" ] || { echo "approve failed, redirect: $LOC"; exit 1; }
  TOKRESP=$(curl -s -X POST $BASE/oauth/token \
    --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" \
    --data-urlencode "redirect_uri=$REDIR" --data-urlencode "client_id=$MINTED_CID" \
    --data-urlencode "code_verifier=$VER" --data-urlencode "resource=$RES")
  MINTED_TOK=$(echo "$TOKRESP" | jq -r .access_token)
  MINTED_REFRESH=$(echo "$TOKRESP" | jq -r '.refresh_token // empty')
  [ "$MINTED_TOK" != null ] || { echo "token error: $TOKRESP"; exit 1; }
  echo "  token scope: $(echo "$TOKRESP" | jq -r .scope)"
}

rpc() {
  curl -s -X POST $RES -H "Authorization: Bearer $MINTED_TOK" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' -d "$1" \
  | sed -n 's/^data: //p;/^{/p' | sed -n '1p'
}
tool() {
  rpc "$(jq -nc --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')" \
    | jq -r '.result.content[0].text // (.error | tostring)'
}
tool_names() { rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq -r '[.result.tools[]?.name] | sort | join(" ")'; }

FAILS=0
check() {
  local desc=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then echo "PASS  $desc"; else echo "FAIL  $desc"; echo "      expected: $expected"; echo "      actual:   $actual"; FAILS=$((FAILS+1)); fi
}

READ_TOOLS="list_folders read_message search_messages"
ALL_TOOLS="delete_draft get_attachment list_folders mark_messages move_messages read_message save_draft search_messages send_draft"

echo "=== read-only grant (no boxes ticked)"
mint_token
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli-test","version":"0"}}}' \
  | jq -c '{server: .result.serverInfo, instructions: .result.instructions}'
check "read-only: tools/list is exactly the 3 read tools" "$(tool_names)" "$READ_TOOLS"
SEND_ERR=$(tool send_draft '{"uid":1}')
echo "      send_draft -> $SEND_ERR"
case "$SEND_ERR" in *"not found"*) check "read-only: send_draft is refused as not found" ok ok ;; *) check "read-only: send_draft is refused as not found" "$SEND_ERR" "…not found…" ;; esac

UID1=$(tool search_messages '{"limit":1}' | jq -r '.messages[0].uid // empty')
echo "--- role keyword as folder (read-only)"
check "search_messages folder=\"drafts\" resolves a role" "$(tool search_messages '{"folder":"drafts","limit":1}' | jq -r 'has("total")')" "true"

echo
echo "=== full grant (every box ticked)"
mint_token draft send organize attachments
check "full grant: tools/list is all 9 tools" "$(tool_names)" "$ALL_TOOLS"
check "full grant: 9 tools" "$(tool_names | wc -w | tr -d ' ')" "9"
if [ -n "$UID1" ]; then
  check "full grant: read_message lists attachments with part ids" \
    "$(tool read_message "{\"uid\":$UID1}" | jq -r '[.attachments[] | has("part")] | all')" "true"
fi

REF=$(curl -s -X POST $BASE/oauth/token --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$MINTED_REFRESH" \
  --data-urlencode "client_id=$MINTED_CID" --data-urlencode "scope=mail:read" --data-urlencode "resource=$RES")
MINTED_TOK=$(echo "$REF" | jq -r .access_token)
check "refresh with scope=mail:read keeps the full grant" "$(tool_names | wc -w | tr -d ' ')" "9"

echo
echo "=== partial grant (draft + organize only)"
mint_token draft organize
check "partial grant: no send, no attachments" "$(tool_names)" "delete_draft list_folders mark_messages move_messages read_message save_draft search_messages"

echo
[ "$FAILS" -eq 0 ] && echo "ALL PASSED" || { echo "$FAILS FAILED"; exit 1; }
