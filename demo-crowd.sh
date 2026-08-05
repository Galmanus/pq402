#!/usr/bin/env bash
# The whole anonymous purchase, in one command.
#
#   ./demo-crowd.sh
#
# An agent buys from an API that charges it, checks it belongs to the issuer's
# set, and never learns which member it is. Both verdicts come from Soroban
# contracts; the server only relays and obeys.
#
# What you should watch for, because it is the point:
#   * the round comes from the LEDGER, not from the server
#   * the server's own response says the ceiling of what it knows
#   * running this twice inside one epoch is refused by the chain, not by code
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-4800}"
PROVER="${PQ_PROVER:-$HERE/bin/prove_crowd}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true' EXIT

[ -f "$HERE/.env" ] && { set -a; . "$HERE/.env"; set +a; }
: "${CROWD_ACT_CONTRACT:?set CROWD_ACT_CONTRACT (the crowd gate)}"
: "${CROWD_MEMBERSHIP_CONTRACT:?set CROWD_MEMBERSHIP_CONTRACT}"
: "${PQ_SOURCE:?set PQ_SOURCE (a stellar identity that can submit)}"
NET="${PQ_NETWORK:-testnet}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. the challenge comes from the ledger, not from us"
ROUND="$(stellar contract invoke --id "$CROWD_ACT_CONTRACT" --source "$PQ_SOURCE" \
          --network "$NET" -- current_round 2>/dev/null | tail -1 | tr -d '"')"
echo "   round ${ROUND:0:24}...  (ledger_sequence / 720, refused if stale)"

say "2. the issuer admits a member: one credential, one root"
SECRET="$(python3 -c "import struct,secrets
print(''.join(struct.pack('<Q', secrets.randbelow(0x7ffffffe)).hex() for _ in range(8)))")"
ACTION="$(python3 -c "import struct; print(''.join(struct.pack('<Q',31+i).hex() for i in range(8)))")"
OUT="$("$PROVER" "$SECRET" "$ACTION" "$ROUND" 7 "$WORK" 12 7)"
ROOT="$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['root'])")"
C="$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['commitment'])")"
echo "   commitment C ${C:0:24}...   (fresh blinder; the leaf appears nowhere)"
echo "   issuer root  ${ROOT:0:24}..."

say "3. the API starts, knowing only the root"
CROWD_ROOT="$ROOT" PORT="$PORT" node "$HERE/examples/crowd-app/server.mjs" > "$WORK/server.log" 2>&1 &
SRV=$!
# The health check looks for 402, not for 2xx: a paywall answering "payment
# required" IS the healthy answer, and `curl -f` treats it as a failure.
up() { [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/premium")" = "402" ]; }
for _ in $(seq 1 40); do up && break; sleep 0.3; done
if ! up; then
  echo; echo "the server did not come up. it said:"; sed 's/^/    /' "$WORK/server.log"; exit 1
fi
echo "   listening on :$PORT — it holds a root, and no list of members"

say "4. the agent proves membership and that it acted, and pays"
python3 - "$WORK" <<'PY'
import base64, json, pathlib, sys
W = pathlib.Path(sys.argv[1])
(W / "unlock.json").write_text(json.dumps({
    "binding_proof_b64": base64.b64encode((W / "crowd_binding.postcard").read_bytes()).decode(),
    "binding_publics_hex": (W / "crowd_binding_publics.le64").read_bytes().hex(),
    "membership_proof_b64": base64.b64encode((W / "crowd_membership.postcard").read_bytes()).decode(),
    "membership_publics_hex": (W / "crowd_membership_publics.le64").read_bytes().hex(),
}))
PY
UNLOCK="$(curl -s --max-time 600 -X POST "http://localhost:$PORT/pq/unlock" \
           -H 'content-type: application/json' --data-binary @"$WORK/unlock.json")"
PASS="$(echo "$UNLOCK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pass',''))")"
if [ -z "$PASS" ]; then
  echo "   refused: $(echo "$UNLOCK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))")"
  echo "   (one credential acts once per epoch — that refusal is the chain working)"
  exit 1
fi
BURN="$(echo "$UNLOCK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('burn_tx',''))")"
echo "   membership verified, nullifier burned by consensus"
echo "   https://stellar.expert/explorer/testnet/tx/$BURN"

PQ_PROVER="" node "$HERE/cli/bin/stellar-agent-pay.mjs" "http://localhost:$PORT/premium" \
  --pq-pass "$PASS" --source "${PAY_SOURCE:-pq402-payer}" --max "${PRICE_USD:-0.10}" --yes

say "5. what the server knows"
echo "   the response above is the whole of it: a member of the set paid."
echo "   not which member. and the next payment by this same credential will"
echo "   share no public value with this one, so they cannot be linked either."
