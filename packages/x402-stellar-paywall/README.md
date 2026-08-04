# x402-stellar-paywall

**One line to charge an AI agent for an HTTP route, on Stellar.**

```bash
npm install x402-stellar-paywall
```

```js
import { expressPaywall } from "x402-stellar-paywall/express";

const pay = await expressPaywall({ price: "0.10", payTo: process.env.STELLAR_RECIPIENT });

app.get("/weather", pay, (req, res) =>
  res.json({ temp: 24, settled_by: req.x402.transaction })
);
```

That is the whole integration. The agent holds **no XLM** — the facilitator
sponsors the network fee — and the handler receives the settlement transaction
on `req.x402` without knowing anything about the protocol.

Hono is the same shape:

```js
import { honoPaywall } from "x402-stellar-paywall/hono";
const pay = await honoPaywall({ price: "0.10", payTo });
app.get("/premium", pay, (c) => c.json({ ok: true, tx: c.get("x402").transaction }));
```

## The other gate

A paywall answers *did they pay*. Metered APIs usually have a second question —
*are they allowed to buy this at all* — and the usual answers, an API key or an
account, make the caller identifiable across every request they ever make.

Pass a `credential` option and the route additionally demands a zero-knowledge
proof, judged by a Soroban contract:

```js
const pay = await expressPaywall({
  price: "0.10",
  payTo: process.env.STELLAR_RECIPIENT,
  credential: { contract: "CA6QM6DR…", source: "my-key" },
});

app.post("/pq/unlock", pay.unlock);   // proofs are traded for single-use passes
app.get("/premium", pay, handler);
```

What the server never learns: which credential. What it does learn: that one
exists, is valid, and has not already been spent on this challenge. The verdict
comes from the contract, which burns a per-challenge nullifier, so single use
survives a restart of your process.

The credential is checked **before** the payment. Charging someone and then
refusing them is worse than refusing them, and it is the server's job not to
arrange that. It is consumed only once the request succeeds, because the x402
handshake sends the same request twice — once to be told the price, once
carrying the payment — and a gate that spent the pass on sight refused its own
second half.

Requires the `stellar` CLI on PATH, and a deployed verifier. The one in the
example is riverrun's post-quantum credential relation; any contract with the
same `spend(proof, publics) -> bool` shape works.

## Why this exists

Getting an x402 client and a Stellar facilitator to agree took four failing
rounds, each with an error message that pointed somewhere other than the cause.
This package encodes all four as **behaviour**, because a comment does not stop
anyone from getting it wrong:

1. **v2 carries the requirements in a `payment-required` HEADER.** The body is
   read only when `x402Version === 1`. A server that publishes perfect
   requirements as JSON alone is invisible to a v2 client, which fails with
   `Invalid payment required response` having never looked at them. Every 402 a
   gated route emits needs the header — including the one that means "you have
   a session but still owe payment", which is the one everybody forgets.
2. **The signed payload returns in `PAYMENT-SIGNATURE`**, with `X-PAYMENT` the
   v1 name. This reads both.
3. **`extra.areFeesSponsored` must be in the requirements** or the Stellar
   exact scheme refuses to build a payment at all. That flag belongs to the
   facilitator, so this fetches `/supported` at startup and copies what it says
   instead of asserting it on the facilitator's behalf.
4. **Stellar USDC has seven decimals, not six.** `0.10` is `1000000` base
   units. The EVM habit is a 10× underpayment that settles quietly, which is
   the worst kind of bug: it works.

## Setup fails loudly, not at the till

`paywall()` is `await`ed because it talks to the facilitator before returning.
A missing or wrong-network API key throws at startup with the command that
fixes it, rather than letting the server advertise a price it cannot settle:

```
paywall: facilitator https://channels.openzeppelin.com/x402/testnet supports no
exact scheme on stellar:testnet. no OZ_API_KEY set — mint one with:
curl -s https://channels.openzeppelin.com/testnet/gen
```

## Options

| option | default | notes |
|---|---|---|
| `price` | required | human units, e.g. `"0.10"` |
| `payTo` | required | classic `G…` account; **needs a USDC trustline** |
| `network` | `stellar:testnet` | CAIP-2 id; `stellar:pubnet` for mainnet |
| `asset` | USDC SAC for the network | the `C…` contract, not the `G…` issuer |
| `facilitatorUrl` | OZ Channels for the network | any x402 facilitator |
| `apiKey` | `process.env.OZ_API_KEY` | required on testnet too |
| `maxTimeoutSeconds` | `60` | bounds the auth entries' ledger validity |
| `resource` | `{}` | `description`, `mimeType`, `serviceName` for the 402 |

**`payTo` is an account, `asset` is a contract.** The scheme invokes `transfer`
on the SAC; the account is what ends up holding the balance, which is also why
it needs a trustline. Mixing them up produces `op_no_trust` at settlement, long
after the mistake.

## Verify before settle

The order is not stylistic. `settle` moves money, so a payload that fails
verification must never reach it. A refusal returns the facilitator's own
reason rather than a bare `402`, and repeats the requirements in the response —
a client retrying with a stale or wrong-priced payload needs the current terms
to recover on its own.

## Framework-free core

Both bindings are thin wrappers over `paywall()`, which returns primitives you
can mount anywhere — FastAPI via a shim, a raw `node:http` server, a worker:

```js
const gate = await paywall({ price: "0.10", payTo });

gate.challengeHeader(url);   // { "payment-required": "<base64url>" }
gate.paymentRequired(url);   // the same object, for the body and for humans
gate.readPayment(getHeader); // PAYMENT-SIGNATURE, falling back to X-PAYMENT
await gate.settle(encoded);  // { ok, settlement } | { ok:false, status, body }
```

## Proven, not asserted

Extracted from [pq402](https://github.com/Galmanus/pq402) and then used to gate
a **different** app — `examples/second-app`, a weather API with no credential
logic in it at all — which an agent paid on Stellar testnet:

```
← 200 unlocked
{"city":"Florianópolis","temp":24,"settled_by":"73d850044aecb628a07b1cc8f9b684fa5…"}
```

That transaction is successful at ledger 3,966,679, and its fee was paid by
`GA6THKUY…` — the facilitator, not the agent.

The same app, re-run against this package **installed from npm** rather than
from the working tree, settles the same way:
`4bfd5a8f75522b20556803ae84857331059d3c74acf92aa27854108b56ec289c`.

## Tests

```bash
npm test    # node --test test/*.mjs
```

Seventeen of them, all offline. What they pin is the protocol shaping — that the
requirements carry the facilitator's own `extra` rather than a claim made on
its behalf, that the challenge decodes to the same document it advertises, that
both payment header names are read, that a bad key fails with the command that
fixes it, and that a failed verify never reaches settle. That last one has a
test because settle moves money and the ordering is the only thing standing
between a rejected payload and a real transfer.

MIT.
