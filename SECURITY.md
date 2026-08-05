# Security notes

Findings from auditing this repository's own code, most recent first. The
on-chain relation and its parameters are audited separately in the
`riverrun-soroban` repository; this file is about the payment-lane code that
lives here and, in the case of the published packages, runs on other people's
servers.

## 2026-08-05 — two issues in the credential gate the package ships (fixed)

**`packages/x402-stellar-paywall/src/credential.mjs`. Fixed the same day.**

- **The eighth challenge limb was a copy of the first (low).** `freshRound`
  read each 4-byte window at offset `(i * 4) % 28`; on a 32-byte buffer the
  eighth limb wrapped back to offset 0, so `limb[7]` equalled `limb[0]` on every
  draw. The challenge was one limb shy of its claimed entropy — not exploitable
  at ~217 remaining bits, but a "fresh" value with a deterministic internal
  relationship, and it ships in the published package. Offset is now `i * 4`
  (offset 28 reads bytes 28..31, which is valid), and a test asserts the two
  limbs are independent across draws.
- **The challenge was not bound to the proof (medium).** unlock consumed a caller-supplied round that need not equal the round embedded in the proof publics, so a client could burn challenge X while proving against round Y and replay the proof against fresh challenges. It now checks the round INSIDE the publics (limbs 8..16) and refuses a supplied round that disagrees.
- **Verify-only mode could grant a replayable pass (medium).** In `verify_q`
  mode (`spend:false` or `queries != 40`) nothing is burned on-chain and the
  module keeps no nullifier set, so the only thing refusing a replayed proof is
  the single-use round — which was optional. Without it, the same proof
  unlocked repeatedly. `unlock` now refuses verify-only mode unless a
  single-use `round` is supplied, turning a silent replay hole into a visible
  400. The default (`spend:true`, 40 queries) was never affected: it burns the
  nullifier in consensus.

## 2026-08-05 — the buyer CLI's --max could be skipped by an unreadable price (fixed)

**Severity: medium. `cli/bin/stellar-agent-pay.mjs`. Fixed the same day.**

`--max` is the agent's spend limit — the whole point of letting a script pay
autonomously. Both the cap check and the confirmation prompt guarded on
`req.usd != null`, and the price could be non-`null` yet unusable in two ways: a
402 that advertises no amount leaves `usd` **null**, and one that advertises a
non-numeric amount leaves it **NaN**. `NaN > max` is `false`, so a NaN price
slid past the cap exactly as a null one slid past the `!= null` guard. Because
the actual payment amount is set by the x402 scheme reading the 402 directly —
not by the CLI's parsed copy — a server whose price this CLI could not read but
the scheme could would collect payment with the agent's `--max` never applied.

**The fix.** The CLI now refuses any 402 whose price is not a finite number,
before the cap or the prompt: if `--max` cannot be honored and the amount cannot
be shown, paying blind is the wrong default. Regression tests pin both bypass
values — a missing amount parses to `null`, a non-numeric one to `NaN`, and
`Number.isFinite` rejects both.

## 2026-08-05 — server robustness: two lower-severity issues (fixed)

Not exploitable for theft, but the kind of rough edge an auditor notices, so
recorded here too.

- **`challenges` grew without bound.** Every `GET /premium` issues a fresh
  challenge and stored it in a map that only shrank on a matching unlock. The
  endpoint is unauthenticated and free, so a flood of requests was a slow
  memory exhaustion. Now challenges carry a TTL, are swept on issuance, and a
  stale one is rejected at unlock rather than merely bounded — freshness, not
  just a memory cap.
- **`POST /pq/register` could hang the request.** Its `JSON.parse` was
  unguarded while `/pq/unlock`'s was wrapped, so a malformed or oversized body
  rejected the async handler with no response sent, leaving the client to time
  out. Now it answers 400, and the whole request dispatcher carries an outer
  guard that returns 500 rather than hanging if any future handler throws past
  its own checks.

## 2026-08-05 — the treasury authenticated nobody (fixed)

**Severity: high. `contracts/agent-treasury`. Fixed the same day.**

`pay` was the treasury's only reachable entry point, and it verified the token
allow-list and the daily cap but never checked *who* was calling. The token
`transfer` moves from the treasury's own address, and a Soroban contract
authorizes its own outgoing calls automatically, so no external signature was
required at all. Anyone on the network could call
`pay(usdc, their_own_address, cap)` once per rolling window and take the whole
daily cap. The cap did not protect the funds; it rate-limited the theft.

The `Signer` key was set at construction and read nowhere afterward. The
`CustomAccountInterface` the module described was never implemented — `__check_auth`
did not exist, and `check_policy` was a free function reached only by tests
calling it directly. So the suite was green (it exercised `check_policy`) while
the deployed door (`pay`) was open and the custom-account door was absent.

**The fix.** `pay` now reads the stored agent and calls `agent.require_auth()`
before anything moves. The auth framework binds that authorization to the exact
`(contract, "pay", token, to, amount)` tuple, so a captured signature cannot be
replayed with a different recipient or amount. The constructor takes an
`agent: Address` in place of the unused ed25519 key; the dead
`CustomAccountInterface` import and `check_policy` are gone. The test suite was
rewritten to drive `pay` through a real registered Stellar Asset Contract rather
than a free function — twelve tests, including one that asserts the recorded
authorizer is the agent bound to the exact call, and one that confirms `pay`
panics when the agent has not authorized. `demo/policy.sh` gains a fourth case:
a payment inside policy but signed by the wrong identity, refused in consensus.

## 2026-08-05 — the server enforced the client's price, not its own (fixed)

**Severity: high. Present in `server.mjs`, the npm package, and the Python twin.
Fixed in all three the same day.**

The paywall forwarded the payer's own copy of the payment terms to the
facilitator:

```js
paymentRequirements: paymentPayload.accepted ?? paymentRequirements()
```

`accepted` is an unsigned field the client fully controls. The facilitator's
`/verify` answers exactly one question — *does this payment satisfy THESE
requirements?* — and has no notion of the server's price beyond what the server
sends it. Forwarding the client's copy therefore let a payer set the terms its
own payment would be checked against.

**The attack.** Sign a Soroban auth entry transferring one base unit (or one
naming any `payTo`), then send a payload whose `accepted` declares
`amount: "1"` and that same `payTo`. `/verify` checks the one-unit transfer
against the one-unit requirement and passes; `/settle` moves one unit; the
server returns 200 and serves the resource. A $0.10 gate unlocks for
$0.0000001, and by setting `accepted.payTo` the payer can direct even that unit
away from the recipient. The signed part of the payload — the auth entry — is
honest; the unsigned `accepted` beside it is what lied, and the server believed
it.

**Why it was wrong, against the reference.** The official `@x402/core` resource
server never trusts `accepted`. It calls `findMatchingRequirements` to select
from the server's *own* advertised list, passes that server-derived requirement
to both `verify` and `settle`, and enforces an explicit mutation policy that
throws if `payTo`, `amount`, or `asset` differ. This paywall advertises exactly
one requirement, so the only correct value is that one.

**The fix.** Send the server's own `requirements()` to `verify` and `settle`,
never the client's echo. For an honest client the two objects are identical, so
nothing legitimate changes; for a tampering one the facilitator now checks the
payment against the price the server actually set, and rejects underpayment or
redirection itself. Regression tests decode a tampered `accepted` and assert
that what reaches the facilitator carries the server's amount, recipient, and
asset — `paywall.test.mjs` and `test_paywall.py`, each verified to fail before
the fix and pass after.

## Earlier, during the build (recorded in git history)

- **The nullifier break.** Publishing `π(secret ‖ round)` in full alongside the
  public round let one permutation inversion recover the secret. Fixed by
  truncating leaf and nullifier to a digest; see the `riverrun-soroban` audit
  and `examples/invert_nullifier.rs`.
- **`--max` was not enforced** in the CLI: it read the v1 `maxAmountRequired`
  against a v2 server emitting `amount`, so the spend guard fell through. Fixed
  by reading the v2 field.
- **The pass was consumed on the first of the two 402 handshakes**, so a paid
  caller was refused. Split `hasPass` from `usePass`.
