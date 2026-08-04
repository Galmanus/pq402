# pq402, one real run, verbatim

Recorded 2026-08-04 on Stellar testnet against verifier
[`CA6QM6DR…`](https://stellar.expert/explorer/testnet/contract/CA6QM6DRPVYRHFWEWNATDIKLL4P47XBI2OWVL7226WHHOTFEY2W2JKET).
**Both lanes real**: the credential is judged by a deployed Soroban contract and
the payment settles USDC through the OpenZeppelin Channels facilitator. Every
hash below is checkable on stellar.expert.

## 0. The server refuses to start without a facilitator

```
$ ./demo.sh
starting pq402 server (payment lane REAL, PQ lane real, on-chain spend)
facilitator https://channels.openzeppelin.com/x402/testnet -> exact/stellar:testnet,
  extra {"areFeesSponsored":true}
pq402 on http://localhost:4470 -- verifier CA6QM6DR... (testnet, q=40)
```

`extra` is discovered, not hardcoded. The Stellar exact scheme refuses to build
a payment unless it finds `areFeesSponsored: true` there, and that flag is the
facilitator's to assert rather than ours to claim on its behalf. Without a key
the server exits instead of advertising a paywall it cannot settle.

## 1. The agent asks, and is told two things at once

```
402 Payment Required: $0.10 CBIELTK6... on stellar:testnet -> GAWAG7OD...
```

The `payment-required` header carries the x402 v2 requirements: 1000000 base
units of USDC, which is `0.10` at Stellar's seven decimals, over the SAC
`CBIELTK6…`. The body carries the post-quantum challenge — a fresh single-use
round, the verifying contract, and the query count.

## 2. The agent proves its credential locally

```
proof: 79186 bytes in 8ms
```

The secret never leaves the machine. The server knows only the leaf, from
registration.

## 3. The chain judges the credential and burns the nullifier

```
PQ verified ON-CHAIN by CA6QM6DR... (testnet, 9390ms) -> pass granted
nullifier burned by consensus:
  .../tx/0da1d074c98c7bde272cc179600c785bdf6b01dae588d6b1fdb78cee45f9a636
```

The server did not decide this. It forwarded the proof to a contract and read
the verdict.

## 4. The agent pays, and the facilitator settles

```
200 unlocked
{
  "premium": "the goods: one paid, PQ-authenticated API response",
  "payment": "x402 settled on Stellar",
  "settlement_tx": "2c8e59290d6f5215cab1840a76433830ad3e3eb8dbcd2e4208e7250de4377993"
}
```

On-chain:

| | |
|---|---|
| ledger | 3,969,391 |
| fee charged | 23,073 stroops |
| **fee paid by** | `GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL` |

The fee account is **not** the agent. That is fee sponsorship: the agent signed
Soroban authorization entries, the facilitator assembled the transaction, paid
the network fee, and submitted it. An agent wallet needs the asset it intends
to spend and no XLM at all.

## 5. One credential, many purchases, each single-use

The second purchase in the same run, on a fresh challenge:

```
proof: 79017 bytes in 10ms
PQ verified ON-CHAIN by CA6QM6DR... (testnet, 6703ms) -> pass granted
nullifier burned by consensus:
  .../tx/b088c02e929db615854da2bee23f19ef73aaeeadfe3ef4325e8e2a730bc81678
200 unlocked
settlement_tx: 75b6ee279b710bbee3db86a2d95b0e914e0074e8597fe00ad41539b2c9cda690
```

A different nullifier, because the challenge was fresh. Across the two
purchases the recipient went from `0.76` to `0.96` USDC.

## 6. A literal replay, refused by the contract

Not part of the scripted run, and the reason the previous section is not the
whole story: a *fresh* proof for a *fresh* challenge is a new spend, but
re-sending an already-spent proof is refused by the verifier itself.

| | tx | result |
|---|---|---|
| first spend | `0f722519e12cc030708e0644bc695ea0b9fe6ccc7a03761c1e7338d4f0e20ec0` | `true` |
| the same proof again | `c1a1a971c67e84e4d851de6e63b6a6521910b0ec00840ef68be59753a9af4959` | `false` |

The refusal is a storage read, not a second STARK verification, so refusing
costs the attacker far more than it costs the chain.

## Every hash in this document

| what | tx |
|---|---|
| credential burn, purchase 1 | `0da1d074c98c7bde272cc179600c785bdf6b01dae588d6b1fdb78cee45f9a636` |
| USDC settlement, purchase 1 | `2c8e59290d6f5215cab1840a76433830ad3e3eb8dbcd2e4208e7250de4377993` |
| credential burn, purchase 2 | `b088c02e929db615854da2bee23f19ef73aaeeadfe3ef4325e8e2a730bc81678` |
| USDC settlement, purchase 2 | `75b6ee279b710bbee3db86a2d95b0e914e0074e8597fe00ad41539b2c9cda690` |
| replay accepted (first use) | `0f722519e12cc030708e0644bc695ea0b9fe6ccc7a03761c1e7338d4f0e20ec0` |
| replay refused (second use) | `c1a1a971c67e84e4d851de6e63b6a6521910b0ec00840ef68be59753a9af4959` |
