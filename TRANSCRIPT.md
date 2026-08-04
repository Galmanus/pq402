# pq402, one real run, verbatim

Recorded 2026-08-02, testnet, production security (40 FRI queries), PQ lane
real. Every hash below is checkable on stellar.expert.

> **This transcript predates real settlement.** It was taken while the payment
> lane was stubbed, which the run states as it goes. The settlement path now
> goes to the facilitator's `/verify` and `/settle` and the stub is opt-in via
> `MOCK_PAYMENT=1`. The proof lane shown here is unchanged and was never
> stubbed. A fresh transcript replaces this one once a facilitator key is in
> place.

## 1. The agent hits the paid API and gets a challenge

```
GET /premium
→ 402
x-pq-action:    ba71a344000000006d68c257000000000e0a0f4f…  (premium-api-access)
x-pq-challenge: <8 fresh M31 elements, single use>
x-pq-contract:  CD72SHMVQ3VLFBMVB4525PYMI42MBJBT3GTP2Q7HFENGNEVMFCRDFFA3
x-pq-queries:   40
```

## 2. The agent proves, locally, in 11 milliseconds

```
$ prove_action <secret> <action> <round> 40 out/
proof_bytes: 78640        real: 0.011s
```

A production-security post-quantum STARK, proved on a laptop faster than a
network round trip.

## 3. Unlock: the chain verifies AND burns the nullifier

```
POST /pq/unlock {proof_b64, publics_hex}
→ 200
{
  "pass": "d70d6a58c1a5ad115d46ff2dc2070491",
  "verified_by": { "contract": "CD72SHMV…FFA3", "num_queries": 40, "mode": "spend" },
  "burn_tx": "82efeae52df4bb254c5cb4240683a70aa0a715663eeaabaa67afa1f83fe4cf71",
  "explorer": "https://stellar.expert/explorer/testnet/tx/82efeae52df4bb254c5cb4240683a70aa0a715663eeaabaa67afa1f83fe4cf71",
  "verify_ms": 9277
}
```

The server did not decide this. A real transaction did: STARK verified (247M
instructions) and nullifier burned in contract storage, single-use by consensus.

## 4. The goods

```
GET /premium  (x-pq-pass + x-payment)
→ 200 { "premium": "the goods: one paid, PQ-authenticated API response", … }
```

## 5. Replay, refused twice over

Same proof, same publics, POSTed again:

```
→ 403 { "error": "unknown or reused challenge round" }
```

The server's challenge layer catches it first (free). If a rogue operator
deleted that check, the chain still refuses: the nullifier is already burned,
and the contract answers `false` for 311,750 instructions, as tx
`c3153c2ea01296bdc2d855a9f11655aa5f3dbf309d7ea0367ae6ab200c9f01e2` demonstrates
on-chain.

## The same flow as ONE command, through the stellar CLI plugin

```
$ stellar agent-pay http://localhost:4402/premium --pq-secret <hex> --yes
→ GET http://localhost:4402/premium
← 402 Payment Required: $0.1 USDC on stellar:testnet → GA4VTIGQ…
proving PQ credential (q=40, contract CD72SHMV…)…
proof: 78976 bytes in 11ms
PQ verified ON-CHAIN by CD72SHMV… (testnet, 4451ms) → pass granted
nullifier burned by consensus:
  https://stellar.expert/explorer/testnet/tx/854ee49629b1f5742277f7a98eae209d41381cc3dfdb50a2fffa59472312c8c0
paying… [MOCK lane, server-declared]
← 200 unlocked
```

## Grand total

One agent, one paid API call, one post-quantum credential: proved in 11ms,
verified and consumed by Stellar consensus in one transaction, unusable a second
time by anyone, including the server operator.
