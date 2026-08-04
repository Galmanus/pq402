# x402-stellar-paywall (Python)

**One line to charge an AI agent for a FastAPI route, on Stellar.**

```bash
# Not on PyPI yet — the name is reserved for the JS half's twin and the token
# is not on this machine. Install from the repo, which is what the example does:
pip install "x402-stellar-paywall[fastapi] @ git+https://github.com/Galmanus/pq402#subdirectory=packages/x402-stellar-paywall-py"

# or, from a clone:
pip install -e packages/x402-stellar-paywall-py[fastapi]
```

```python
from fastapi import Depends, FastAPI
from x402_stellar_paywall.fastapi import paywall_dependency

app = FastAPI()
pay = paywall_dependency(price="0.10", pay_to=os.environ["STELLAR_RECIPIENT"])

@app.get("/premium")
def premium(settlement=Depends(pay)):
    return {"secret": "the goods", "settled_by": settlement["transaction"]}
```

The agent holds **no XLM** — the facilitator sponsors the network fee — and the
handler receives the settlement without knowing anything about the protocol.

Proven: that exact app, paid by an agent on Stellar testnet, settlement
`665e70afb5c9ebf9149085b590e384268e8826ccc9f590b4b8b20c6318b40dd3`.

## Why this exists

It is the Python half of
[`x402-stellar-paywall`](https://www.npmjs.com/package/x402-stellar-paywall),
carrying the same four protocol details that each cost a debugging round:

1. **v2 carries the requirements in a `payment-required` HEADER.** The body is
   read only when `x402Version == 1`. A server that publishes perfect
   requirements as JSON alone is invisible to a v2 client, which fails with
   `Invalid payment required response` having never looked at them.
2. **The signed payload returns in `PAYMENT-SIGNATURE`**, with `X-PAYMENT` the
   v1 name. This reads both.
3. **`extra.areFeesSponsored` must be in the requirements** or the Stellar
   exact scheme refuses to build a payment. That flag belongs to the
   facilitator, so this fetches `/supported` at construction and copies what it
   says instead of asserting it on the facilitator's behalf.
4. **Stellar assets carry seven decimals, not six.** `0.10` is `1000000` base
   units, computed with `Decimal` so the arithmetic does not drift.

## Setup fails at import, not at the till

`paywall_dependency()` talks to the facilitator while building. A missing or
wrong-network key raises there, with the command that fixes it, rather than
letting the process serve a price it cannot settle:

```
PaywallError: facilitator https://channels.openzeppelin.com/x402/testnet supports
no exact scheme on stellar:testnet. no api_key set — mint one with:
curl -s https://channels.openzeppelin.com/testnet/gen
```

## Framework-free core

`Paywall` is plain Python with no dependencies and no framework assumptions —
mount it on Flask, Django, or a bare WSGI app:

```python
from x402_stellar_paywall import Paywall

gate = Paywall(price="0.10", pay_to=PAY_TO)
gate.challenge_header(url)     # {"payment-required": "<base64url>"}
gate.payment_required(url)     # the same document, for the body and for humans
gate.read_payment(get_header)  # PAYMENT-SIGNATURE, falling back to X-PAYMENT
gate.settle(encoded)           # SettleResult(ok, settlement | status, body)
```

Standard library only. `pip install x402-stellar-paywall` drags nothing in;
the `[fastapi]` extra is only for the binding.

## Verify before settle

Not stylistic. `settle` moves money, so a payload that fails verification must
never reach it, and a test asserts that a rejected verify leaves `settle`
uncalled. A refusal returns the facilitator's own reason rather than a bare
`402`, and repeats the requirements so a client retrying with a stale payload
can recover on its own.

## Tests

```bash
python3 -m pytest tests -q     # 9 passed
```

All offline. What they pin is the protocol shaping, which is where the four
rounds above actually happened.

MIT.
