#!/usr/bin/env bash
# One-command demo: issue a credential, then watch an agent hit the paywall,
# prove the post-quantum credential, get it verified AND burned on-chain, pay,
# and receive the goods. Requires: node 18+, stellar CLI, the prove_action
# binary (built from mirror-pool's riverrun-m31), and the stellar-agent-pay
# plugin checked out next to this repo or on PATH.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROVER="${PQ_PROVER:-$HOME/projects/mirror-pool/crates/riverrun-m31/target/release/examples/prove_action}"
PLUGIN="${AGENT_PAY:-$HERE/cli/bin/stellar-agent-pay.mjs}"
PORT="${PORT:-4402}"
WORK="$(mktemp -d)"
trap 'kill $SRV 2>/dev/null || true; rm -rf "$WORK"' EXIT

if [ ! -x "$PROVER" ]; then
  echo "prover not found at $PROVER" >&2
  echo "build it: cd mirror-pool/crates/riverrun-m31 && cargo build --release --example prove_action --features wire-postcard" >&2
  exit 1
fi

echo "▸ starting pq402 server (payment lane MOCK, PQ lane real, on-chain spend)"
(cd "$HERE" && MOCK_PAYMENT=1 PORT="$PORT" node server.mjs > "$WORK/server.log" 2>&1) &
SRV=$!
for i in $(seq 1 20); do curl -sf "http://localhost:$PORT/" > /dev/null && break; sleep 0.3; done

echo "▸ issuing a credential (secret stays with the agent; the server learns only the leaf)"
SECRET="$(python3 -c "import struct,secrets
print(''.join(struct.pack('<Q', secrets.randbelow(0x7ffffffe)).hex() for _ in range(8)))")"
ACTION="$(curl -s -D- -o /dev/null "http://localhost:$PORT/premium" | tr -d '\r' | awk 'tolower($1)=="x-pq-action:"{print $2}')"
DUMMY="$(python3 -c "import struct; print(''.join(struct.pack('<Q',1).hex() for _ in range(8)))")"
LEAF="$("$PROVER" "$SECRET" "$ACTION" "$DUMMY" 4 "$WORK" | python3 -c "import json,sys; print(json.load(sys.stdin)['leaf'])")"
curl -s -X POST "http://localhost:$PORT/pq/register" -H 'content-type: application/json' \
  -d "{\"leaf\":\"$LEAF\"}" | python3 -m json.tool

echo
echo "▸ the agent pays (watch the burn tx line: single-use enforced by the chain)"
PQ_PROVER="$PROVER" node "$PLUGIN" "http://localhost:$PORT/premium" --pq-secret "$SECRET" --yes

echo
echo "▸ same credential again: a FRESH proof for a fresh challenge (must succeed, new nullifier, new burn)"
PQ_PROVER="$PROVER" node "$PLUGIN" "http://localhost:$PORT/premium" --pq-secret "$SECRET" --yes

echo
echo "▸ one credential, many single-use proofs, each burned by consensus."
echo "  A literal replay (re-sending an already-spent proof) is refused by the"
echo "  contract itself: see txs 35d6e7e8 (true) and 06a82052 (false) in the repo README."
