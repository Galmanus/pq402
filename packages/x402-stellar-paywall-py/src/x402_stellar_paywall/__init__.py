"""x402-stellar-paywall — charge an AI agent for an HTTP route, on Stellar.

The Python half of https://www.npmjs.com/package/x402-stellar-paywall, same
protocol and same four hard-won details, for FastAPI and anything else that can
read a header.

    from x402_stellar_paywall.fastapi import paywall_dependency

    pay = paywall_dependency(price="0.10", pay_to=os.environ["STELLAR_RECIPIENT"])

    @app.get("/premium", dependencies=[pay])
    def premium():
        return {"secret": "the goods"}

Four details are encoded as behaviour here, because a comment does not stop
anyone from getting them wrong:

1. v2 carries the requirements in a ``payment-required`` HEADER. The body is
   read only when ``x402Version == 1``. A server that publishes perfect
   requirements as JSON alone is invisible to a v2 client, which fails with
   "Invalid payment required response" having never looked at them.
2. The signed payload returns in ``PAYMENT-SIGNATURE``; ``X-PAYMENT`` is the v1
   name. Read both.
3. ``extra.areFeesSponsored`` must be in the requirements or the Stellar exact
   scheme refuses to build a payment. That flag belongs to the facilitator, so
   it is fetched from ``/supported`` rather than asserted on its behalf.
4. Stellar assets carry SEVEN decimals. ``0.10`` is ``1000000`` base units; the
   six an EVM habit expects is a tenth of the price, settling quietly.

Standard library only, so installing it drags nothing else in.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable

__all__ = [
    "Paywall",
    "PaywallError",
    "SettleResult",
    "USDC_SAC",
    "FACILITATOR",
    "to_base_units",
]

#: USDC's Soroban Asset Contract. Not the classic ``G...`` issuer: the scheme
#: invokes ``transfer`` on this contract, while ``pay_to`` is the account that
#: ends up holding the balance — which is why that account needs a trustline.
USDC_SAC = {
    "stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
}

FACILITATOR = {
    "stellar:testnet": "https://channels.openzeppelin.com/x402/testnet",
    "stellar:pubnet": "https://channels.openzeppelin.com/x402",
}

#: Stellar assets carry seven decimals, not six.
STELLAR_DECIMALS = 7


def to_base_units(human: str | float | Decimal) -> str:
    """``"0.10"`` -> ``"1000000"``. Decimal, so 0.1 does not become 0.09999."""
    return str(int(Decimal(str(human)) * (10**STELLAR_DECIMALS)))


class PaywallError(RuntimeError):
    """Raised at construction, never per-request: a misconfigured paywall
    should fail when it starts rather than when someone tries to pay."""


@dataclass
class SettleResult:
    ok: bool
    settlement: dict[str, Any] | None = None
    status: int = 402
    body: dict[str, Any] = field(default_factory=dict)


class Paywall:
    """A paywall for one price and one recipient.

    Construction talks to the facilitator, so a wrong key or a wrong network
    raises here rather than letting the process advertise a price it cannot
    settle.
    """

    def __init__(
        self,
        *,
        price: str,
        pay_to: str,
        network: str = "stellar:testnet",
        asset: str | None = None,
        facilitator_url: str | None = None,
        api_key: str | None = None,
        max_timeout_seconds: int = 60,
        resource: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not price:
            raise PaywallError("price is required, e.g. price='0.10'")
        if not pay_to:
            raise PaywallError(
                "pay_to is required (a classic G... account with a USDC trustline)"
            )

        self.price = price
        self.pay_to = pay_to
        self.network = network
        self.timeout = timeout
        self.max_timeout_seconds = max_timeout_seconds
        self.resource = resource or {}
        self.api_key = api_key

        self.url = facilitator_url or FACILITATOR.get(network)
        if not self.url:
            raise PaywallError(f"no facilitator preset for {network}; pass facilitator_url")
        self.asset = asset or USDC_SAC.get(network)
        if not self.asset:
            raise PaywallError(f"no USDC preset for {network}; pass asset")

        # Ask what the facilitator supports instead of claiming it. The Stellar
        # exact scheme refuses to build a payment unless it finds
        # areFeesSponsored in the requirements, and that is the facilitator's
        # assertion to make.
        kinds = self._call("supported", {}).get("kinds") or []
        kind = next(
            (k for k in kinds if k.get("network") == network and k.get("scheme") == "exact"),
            None,
        )
        if kind is None:
            hint = (
                "the key may be for another network."
                if api_key
                else "no api_key set — mint one with: "
                "curl -s https://channels.openzeppelin.com/testnet/gen"
            )
            raise PaywallError(
                f"facilitator {self.url} supports no exact scheme on {network}. {hint}"
            )
        self.extra = kind.get("extra") or {}

    # -- facilitator ------------------------------------------------------

    def _call(self, kind: str, body: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(f"{self.url}/{kind}", data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                parsed = json.loads(raw)
            except ValueError:
                raise PaywallError(f"facilitator {kind} {e.code}: {raw[:200]}") from None
            raise PaywallError(f"facilitator {kind} {e.code}: {parsed}") from None

    # -- protocol shaping -------------------------------------------------

    def requirements(self) -> dict[str, Any]:
        r: dict[str, Any] = {
            "scheme": "exact",
            "network": self.network,
            "amount": to_base_units(self.price),
            "asset": self.asset,
            "payTo": self.pay_to,
            "maxTimeoutSeconds": self.max_timeout_seconds,
        }
        if self.extra:
            r["extra"] = self.extra
        return r

    def payment_required(self, request_url: str) -> dict[str, Any]:
        return {
            "x402Version": 2,
            "resource": {
                "url": request_url,
                "description": self.resource.get("description", "paid resource"),
                "mimeType": self.resource.get("mimeType", "application/json"),
                **(
                    {"serviceName": self.resource["serviceName"]}
                    if "serviceName" in self.resource
                    else {}
                ),
            },
            "accepts": [self.requirements()],
        }

    def challenge_header(self, request_url: str) -> dict[str, str]:
        """The requirements as the base64url header a v2 client actually reads."""
        doc = json.dumps(self.payment_required(request_url)).encode()
        return {"payment-required": base64.urlsafe_b64encode(doc).decode().rstrip("=")}

    @staticmethod
    def read_payment(get_header: Callable[[str], str | None]) -> str | None:
        """v2 signs into PAYMENT-SIGNATURE; X-PAYMENT is the v1 name."""
        return get_header("payment-signature") or get_header("x-payment") or None

    # -- settlement -------------------------------------------------------

    def settle(self, encoded_payment: str) -> SettleResult:
        """Verify, then settle. In that order and never the other: settle moves
        money, so a payload that fails verification must not reach it."""
        try:
            padded = encoded_payment + "=" * (-len(encoded_payment) % 4)
            payload = json.loads(base64.b64decode(padded))
        except Exception:
            return SettleResult(
                ok=False, status=402, body={"error": "payment header is not base64 JSON"}
            )

        envelope = {
            "x402Version": payload.get("x402Version", 2),
            "paymentPayload": payload,
            "paymentRequirements": payload.get("accepted") or self.requirements(),
        }
        try:
            v = self._call("verify", envelope)
            if v.get("isValid") is False:
                return SettleResult(
                    ok=False,
                    status=402,
                    body={"error": "payment rejected", "reason": v.get("invalidReason", v)},
                )
            s = self._call("settle", envelope)
            if s.get("success") is False:
                return SettleResult(
                    ok=False, status=402, body={"error": "settlement failed", "reason": s}
                )
            return SettleResult(ok=True, settlement=s)
        except PaywallError as e:
            return SettleResult(ok=False, status=502, body={"error": str(e)})
