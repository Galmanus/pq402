# pq402, one real run, verbatim

Recorded 2026-08-04 on Stellar testnet. **Both lanes real**: the credential is
judged by a deployed Soroban contract, and the payment settles USDC through the
OpenZeppelin Channels facilitator. Every hash below is checkable on
stellar.expert.

## 0. The server refuses to start without a facilitator

```
$ node server.mjs
facilitator https://channels.openzeppelin.com/x402/testnet → exact/stellar:testnet,
  extra {"areFeesSponsored":true}
pq402 on http://localhost:4423 — verifier CD72SHMV… (testnet, q=40)
```

The `extra` block is discovered, not hardcoded. The Stellar exact scheme
refuses to build a payment unless it finds `areFeesSponsored: true` there, and
that flag is the facilitator's to assert rather than ours to claim on its
behalf. With no key the server exits instead of starting in a state where it
would advertise a paywall it cannot settle.

## 1. The agent asks, and is told two things at once

```
→ GET http://localhost:4423/premium
← 402 Payment Required
```

The `payment-required` header carries the x402 v2 requirements: 1000000 base
units of USDC — 0.10, at Stellar's seven decimals — over the SAC `CBIELTK6…`,
paid to `GAWAG7OD…`. The body carries the post-quantum challenge: a fresh
single-use round, the verifying contract, and the query count.

## 2. The agent proves its credential locally

```
proving PQ credential (q=40, contract CD72SHMV…)…
proof: 79227 bytes in 12ms
```

The secret never leaves the machine. The server knows only the leaf, which it
was given at registration.

## 3. The chain judges the credential and burns the nullifier

```
PQ verified ON-CHAIN by CD72SHMV… (testnet, 7164ms) → pass granted
nullifier burned by consensus:
  https://stellar.expert/explorer/testnet/tx/ddc77ecb804691aac7f84a13dfbe24f84d87e90fb526a2ee93ad142b45300ee9
```

The server did not decide this. It forwarded the proof to a contract and read
the verdict. Replay is refused by contract storage, so restarting the server
does not reopen a spent credential.

## 4. The agent pays, and the facilitator settles

```
paying…
← 200 unlocked
{
  "premium": "the goods: one paid, PQ-authenticated API response",
  "credential": "7169473d00000000…",
  "payment": "x402 settled on Stellar",
  "settlement_tx": "f8c8fb36379f83ce9fbb11756c5d1bf9efe5b38bdedc95f2116d63fdb8de3409"
}
```

On-chain, that transaction:

| | |
|---|---|
| successful | `true` |
| ledger | 3,966,485 |
| fee charged | 23,073 stroops |
| **fee paid by** | `GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL` |

The fee account is **not** the agent. That is fee sponsorship working: the
agent signed Soroban authorization entries, the facilitator assembled the
transaction, paid the network fee, and submitted it. An agent wallet needs the
asset it intends to spend and no XLM at all.

Balances moved:

```
payer      20.0000000 → 19.9000000 USDC
recipient   0.0000000 →  0.1000000 USDC
```

## 5. One credential, many purchases, each single-use

The same agent, run again with the **same** credential:

```
proof: 79270 bytes in 16ms
PQ verified ON-CHAIN by CD72SHMV… (testnet, 13775ms) → pass granted
nullifier burned by consensus:
  https://stellar.expert/explorer/testnet/tx/9d58e2d7bab6f4a839e62b51aa2723216a33f8c04fd00f2f58b3f622fd9a82bc
← 200 unlocked
settlement_tx: dae4c7a431bb4789e46060cbaaa00a7bf1e17708a2b522bfad515a3b956d81a9
```

A different nullifier, because the challenge was fresh. A *literal* replay —
re-sending an already-spent proof — is refused by the contract itself.

## The four hashes

| what | tx |
|---|---|
| credential burn, purchase 1 | `ddc77ecb804691aac7f84a13dfbe24f84d87e90fb526a2ee93ad142b45300ee9` |
| USDC settlement, purchase 1 | `f8c8fb36379f83ce9fbb11756c5d1bf9efe5b38bdedc95f2116d63fdb8de3409` |
| credential burn, purchase 2 | `9d58e2d7bab6f4a839e62b51aa2723216a33f8c04fd00f2f58b3f622fd9a82bc` |
| USDC settlement, purchase 2 | `dae4c7a431bb4789e46060cbaaa00a7bf1e17708a2b522bfad515a3b956d81a9` |
