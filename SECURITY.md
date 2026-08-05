# Security notes

Findings from auditing this repository's own code, most recent first. The
on-chain relation and its parameters are audited separately in the
`riverrun-soroban` repository; this file is about the payment-lane code that
lives here and, in the case of the published packages, runs on other people's
servers.

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
