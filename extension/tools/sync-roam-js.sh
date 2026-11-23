#!/usr/bin/env bash
# RahalOS: sync-roam-js.sh — writes dist/roam-js.block.js into the roam/js source block of Roam
# Vaults Fork (RahalOS graph, Roam Local API on :3333) and verifies it byte for byte.
#   --check           build gate + preimage check, no write
#   --write           build gate + preimage check + write + verify (after Daniel's approval)
#   --create PARENT   first install only: create the source block under PARENT (the {{[[roam/js]]}} block)
# The block UID and the approved preimage live in tools/deployment.local.json (kept out of git:
# .git/info/exclude). Never prints the token. Run `npm run build` first.
set -euo pipefail
usage() { echo "usage: $(basename "$0") --check | --write | --create <parent-uid>" >&2; exit 64; }
[ "$#" -ge 1 ] || usage
MODE="$1"
case "$MODE" in --check|--write) [ "$#" -eq 1 ] || usage ;; --create) [ "$#" -eq 2 ] || usage; PARENT="$2" ;; *) usage ;; esac
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$DIR/dist/roam-js.block.js"
DEP="$DIR/tools/deployment.local.json"
GRAPH="RahalOS"; API="http://127.0.0.1:3333/api/$GRAPH"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

[ -f "$SRC" ] || { echo "missing $SRC: run npm run build"; exit 1; }
[ "$(grep -c '`' "$SRC" || true)" = "0" ] || { echo "source contains backticks"; exit 1; }
node --check "$SRC"
echo "gate: ok ($(wc -c < "$SRC" | tr -d ' ') bytes, sha $(shasum -a 256 "$SRC" | cut -d' ' -f1))"
TOKEN="$(jq -r '.graphs[] | select(.name=="'"$GRAPH"'") | .token' "$HOME/.roam-tools.json")"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "NO TOKEN"; exit 1; }
call() { curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @"$1"; }
pull_stripped() { # uid out
  jq -n --arg uid "$1" '{action:"pull", args:["[:block/uid :block/string]", ("[:block/uid \""+$uid+"\"]")], expectedApiVersion:"1.1.2"}' > "$TMP/p.json"
  call "$TMP/p.json" | jq -r '.result[":block/string"] // ""' \
  | node -e 'let s=require("fs").readFileSync(0,"utf8");s=s.replace(/^```[a-z]*\n?/,"").replace(/```\s*$/,"");process.stdout.write(s)' > "$2"
}
# The stored string must end exactly with the closing fence (no trailing newline) or roam/js skips it.
{ printf '```javascript\n'; cat "$SRC"; printf '```'; } > "$TMP/w.md"
record() { jq -n --arg uid "$1" --arg sha "$(shasum -a 256 "$SRC" | cut -d' ' -f1)" --arg at "$(date +%F)" \
  '{graph:"RahalOS", sourceUid:$uid, sourceSha256:$sha, deployedAt:$at}' > "$DEP"; }
verify() { # uid
  pull_stripped "$1" "$TMP/verify.js"
  cmp -s "$TMP/verify.js" "$SRC" || { echo "VERIFY FAILED"; exit 1; }
  echo "BYTE-FIDELITY: EXACT MATCH — $1 ($(shasum -a 256 "$SRC" | cut -d' ' -f1))"
}

if [ "$MODE" = "--create" ]; then
  [ ! -f "$DEP" ] || { echo "already installed ($DEP): use --check / --write"; exit 1; }
  UID_NEW="$(node -e 'const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";process.stdout.write(Array.from(require("crypto").randomBytes(9),(x)=>c[x%62]).join(""))')"
  jq -Rs --arg p "$PARENT" --arg u "$UID_NEW" '{action:"data.block.create", args:[{location:{"parent-uid":$p, order:"last"}, block:{uid:$u, string: .}}], expectedApiVersion:"1.1.2"}' "$TMP/w.md" > "$TMP/w.json"
  RESP="$(call "$TMP/w.json")"
  echo "$RESP" | jq -e '.success == true' >/dev/null || { echo "CREATE FAILED: $(echo "$RESP" | head -c 300)"; exit 1; }
  verify "$UID_NEW"; record "$UID_NEW"; echo "recorded $DEP"; exit 0
fi

BLOCK_UID="$(jq -r '.sourceUid' "$DEP")"; PREIMAGE_SHA="$(jq -r '.sourceSha256' "$DEP")"
pull_stripped "$BLOCK_UID" "$TMP/live.js"
LIVE_SHA="$(shasum -a 256 "$TMP/live.js" | cut -d' ' -f1)"
echo "live sha:     $LIVE_SHA"; echo "preimage sha: $PREIMAGE_SHA"
[ "$LIVE_SHA" = "$PREIMAGE_SHA" ] || { echo "PREIMAGE MISMATCH — stop."; exit 2; }
[ "$MODE" = "--check" ] && exit 0
jq -Rs --arg u "$BLOCK_UID" '{action:"data.block.update", args:[{block:{uid:$u, string: .}}], expectedApiVersion:"1.1.2"}' "$TMP/w.md" > "$TMP/w.json"
RESP="$(call "$TMP/w.json")"
echo "$RESP" | jq -e '.success == true' >/dev/null || { echo "WRITE FAILED: $(echo "$RESP" | head -c 300)"; exit 1; }
verify "$BLOCK_UID"; record "$BLOCK_UID"; echo "recorded $DEP"
