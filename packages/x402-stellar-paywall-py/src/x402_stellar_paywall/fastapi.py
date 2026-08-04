"""FastAPI binding.

    from fastapi import FastAPI, Depends
    from x402_stellar_paywall.fastapi import paywall_dependency

    app = FastAPI()
    pay = paywall_dependency(price="0.10", pay_to=os.environ["STELLAR_RECIPIENT"])

    @app.get("/premium")
    def premium(settlement=Depends(pay)):
        return {"secret": "the goods", "settled_by": settlement["transaction"]}

The dependency returns the settlement, so a handler can log the transaction or
return it without knowing anything about the protocol. A request that has not
paid never reaches the handler: the dependency raises a 402 carrying the
requirements in both the header a v2 client reads and the body a human does.

Importing THIS module requires FastAPI; importing the package root does not, so
a non-FastAPI user drags nothing extra in.
"""

from typing import Any, Callable

from fastapi import HTTPException, Request

from . import Paywall


def paywall_dependency(**options: Any) -> Callable[..., Any]:
    """Build the paywall and return a FastAPI dependency over it.

    Constructed once at import time, which is where a bad key or a wrong
    network should surface — not on the first request that tries to pay.
    """
    gate = Paywall(**options)

    # `Request` must be resolvable from THIS module's globals: FastAPI reads
    # annotations with get_type_hints, and a name imported inside the factory —
    # or a stringified annotation under `from __future__ import annotations` —
    # is invisible to it. The symptom is a 422 complaining that a query
    # parameter named "request" is missing, which points nowhere near the cause.
    async def dependency(request: Request) -> dict:
        request_url = str(request.url)
        payment = gate.read_payment(lambda h: request.headers.get(h))
        if not payment:
            raise HTTPException(
                status_code=402,
                detail=gate.payment_required(request_url),
                headers=gate.challenge_header(request_url),
            )

        result = gate.settle(payment)
        if not result.ok:
            # A refusal repeats the requirements: a client retrying with a
            # stale or wrong-priced payload needs the current terms to recover.
            raise HTTPException(
                status_code=result.status,
                detail=result.body,
                headers=gate.challenge_header(request_url),
            )
        return result.settlement or {}

    dependency.gate = gate  # type: ignore[attr-defined]
    return dependency
