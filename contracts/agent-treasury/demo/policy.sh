#!/usr/bin/env bash
# The three payments the sub-lane asks to see, against a live contract.
#
#   TREASURY=C... RECIPIENT=G... ./demo/policy.sh
#
# One inside policy settles. Two outside it are refused by the contract, in
# consensus, before any token moves — one for the daily cap, one for the
# allow-list. The client is identical in all three: only the contract disagrees.
set -euo pipefail

NET="${NETWORK:-testnet}"
SRC="${SOURCE:-riverrun-registry-deployer}"
R="${RECIPIENT:?set RECIPIENT to a G... account with a USDC trustline}"
FUNDER="${FUNDER:?set FUNDER to a stellar identity holding testnet USDC}"
USDC="${USDC_SAC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"
XLM="$(stellar contract id asset --asset native --network "$NET" | tail -1)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CAP="${CAP:-300000}"   # 0.03 USDC per rolling day

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# A FRESH treasury every run, so the demo starts from a known budget and can be
# replayed. A demo whose outcome depends on what a previous run spent is not a
# demo, it is a coincidence.
if [ -z "${TREASURY:-}" ]; then
  say "deploying a fresh treasury (cap ${CAP} base units)"
  [ -f "$HERE/target/wasm32v1-none/release/agent_treasury.optimized.wasm" ] || {
    (cd "$HERE" && cargo build --target wasm32v1-none --release &&
      stellar contract optimize --wasm target/wasm32v1-none/release/agent_treasury.wasm)
  }
  # The agent is the only principal whose signature `pay` will accept. Here it
  # is the identity that submits the payments below; anyone else is refused in
  # consensus, which case 4 demonstrates.
  AGENT="${AGENT:-$(stellar keys address "$SRC")}"
  T="$(stellar contract deploy \
        --wasm "$HERE/target/wasm32v1-none/release/agent_treasury.optimized.wasm" \
        --source "$SRC" --network "$NET" \
        -- --agent "$AGENT" --allowed "[\"$USDC\"]" --daily_cap "$CAP" 2>&1 | tail -1)"
  echo "treasury $T"
  say "funding it with 0.5 USDC"
  stellar contract invoke --send=yes --id "$USDC" --source "$FUNDER" --network "$NET" \
    -- transfer --from "$(stellar keys address "$FUNDER")" --to "$T" --amount 5000000 >/dev/null 2>&1
else
  T="$TREASURY"
fi

budget() { stellar contract invoke --id "$T" --source "$SRC" --network "$NET" -- remaining 2>/dev/null | tail -1; }

say "policy, read from the chain"
stellar contract invoke --id "$T" --source "$SRC" --network "$NET" -- policy 2>/dev/null | tail -1
echo "remaining: $(budget) base units"

say "1. INSIDE policy — 0.02 USDC"
stellar contract invoke --send=yes --id "$T" --source "$SRC" --network "$NET" \
  -- pay --token "$USDC" --to "$R" --amount 200000 2>&1 | grep -E '🔗' || true
echo "remaining: $(budget)"

# The refusals make the CLI exit non-zero, which under `pipefail` would fail
# the pipeline before grep ever sees the message. Capture first, match after.
say "2. OUTSIDE policy — 0.02 more, against a ${CAP}-unit daily cap"
OUT="$(stellar contract invoke --send=yes --id "$T" --source "$SRC" --network "$NET" \
        -- pay --token "$USDC" --to "$R" --amount 200000 2>&1 || true)"
case "$OUT" in
  *"Error(Contract, #3)"*) echo "REFUSED by the contract — #3, DailyCapExceeded" ;;
  *) echo "the cap did not hold:"; echo "$OUT" | tail -3; exit 1 ;;
esac

say "3. OUTSIDE policy — a token the treasury was never told about"
OUT="$(stellar contract invoke --send=yes --id "$T" --source "$SRC" --network "$NET" \
        -- pay --token "$XLM" --to "$R" --amount 1 2>&1 || true)"
case "$OUT" in
  *"Error(Contract, #2)"*) echo "REFUSED by the contract — #2, ContractNotAllowed" ;;
  *) echo "the allow-list did not hold:"; echo "$OUT" | tail -3; exit 1 ;;
esac

say "4. UNAUTHORIZED — a payment inside policy, but signed by the wrong identity"
# Inside the allow-list and under the cap, so only the missing agent signature
# stands between this call and the money. STRANGER submits and authorizes with
# its own key; the contract requires the AGENT's, which the stranger cannot
# produce. This is the finding SECURITY.md records, closed: without it, any
# identity could have drained the cap here.
STRANGER="${STRANGER:-$FUNDER}"
if [ "$(stellar keys address "$STRANGER")" = "$(stellar keys address "$SRC")" ]; then
  echo "skipped: set STRANGER to an identity other than SOURCE to see this case"
else
  OUT="$(stellar contract invoke --send=yes --id "$T" --source "$STRANGER" --network "$NET" \
          -- pay --token "$USDC" --to "$R" --amount 100000 2>&1 || true)"
  case "$OUT" in
    *"Error(Auth"*|*"InvalidAction"*|*"authorization"*|*"require_auth"*|*"Unauthorized"*)
      echo "REFUSED in consensus — the stranger's signature is not the agent's" ;;
    *"Error(Contract"*)
      echo "refused, but by policy not by auth — unexpected:"; echo "$OUT" | tail -3; exit 1 ;;
    *) echo "the agent gate did not hold:"; echo "$OUT" | tail -3; exit 1 ;;
  esac
fi

say "remaining after the refusals: $(budget) — a refusal costs no budget"
