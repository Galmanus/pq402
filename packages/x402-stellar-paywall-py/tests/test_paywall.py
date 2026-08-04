"""Offline tests for the protocol shaping. Run: python3 -m pytest tests -q

Everything network-facing is stubbed. What is worth pinning here is exactly
what took four failing rounds to discover in the JavaScript half.
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from x402_stellar_paywall import FACILITATOR, USDC_SAC, Paywall, PaywallError, to_base_units


def fake(monkeypatch, *, extra=None, verify=None, settle=None, calls=None):
    """Replace the facilitator with something that answers and records."""
    extra = {"areFeesSponsored": True} if extra is None else extra

    def _call(self, kind, body):
        if calls is not None:
            calls.append(kind)
        if kind == "supported":
            return {"kinds": [{"network": "stellar:testnet", "scheme": "exact", "extra": extra}]}
        if kind == "verify":
            return verify or {"isValid": True}
        if kind == "settle":
            return settle or {"success": True, "transaction": "abc123"}
        return {}

    monkeypatch.setattr(Paywall, "_call", _call)


PAY_TO = "GAWAG7OD4GEMQZWPQGIQDHHEUAWNJJ7VXK2VQKO3STXAJMRCNY2USAHB"


def test_seven_decimals_not_six():
    # The EVM habit is a tenth of the intended price, settling quietly.
    assert to_base_units("0.10") == "1000000"
    assert to_base_units("1") == "10000000"
    # Decimal, so 0.1 does not arrive as 0.09999999.
    assert to_base_units(0.1) == "1000000"


def test_the_usdc_preset_is_the_contract_not_the_issuer():
    assert USDC_SAC["stellar:testnet"].startswith("C")
    assert USDC_SAC["stellar:pubnet"].startswith("C")
    assert "testnet" in FACILITATOR["stellar:testnet"]


def test_requirements_carry_the_facilitators_extra(monkeypatch):
    fake(monkeypatch, extra={"areFeesSponsored": True, "somethingNew": 1})
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    r = gate.requirements()
    assert r["extra"] == {"areFeesSponsored": True, "somethingNew": 1}
    assert r["amount"] == "1000000"
    assert r["scheme"] == "exact"


def test_the_challenge_header_decodes_to_the_same_document(monkeypatch):
    fake(monkeypatch)
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    h = gate.challenge_header("http://x/premium")
    raw = h["payment-required"]
    doc = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    assert doc["x402Version"] == 2
    assert doc["resource"]["url"] == "http://x/premium"
    assert doc["accepts"][0] == gate.requirements()


def test_both_payment_header_names_are_read(monkeypatch):
    fake(monkeypatch)
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    assert gate.read_payment(lambda h: "v2" if h == "payment-signature" else "v1") == "v2"
    assert gate.read_payment(lambda h: "v1" if h == "x-payment" else None) == "v1"
    assert gate.read_payment(lambda h: None) is None


def test_a_facilitator_with_no_matching_scheme_refuses_to_start(monkeypatch):
    monkeypatch.setattr(Paywall, "_call", lambda self, k, b: {"kinds": []})
    try:
        Paywall(price="0.10", pay_to=PAY_TO)
    except PaywallError as e:
        assert "channels.openzeppelin.com/testnet/gen" in str(e)
    else:
        raise AssertionError("a paywall that cannot settle must not start")


def test_verify_precedes_settle_and_a_failed_verify_never_reaches_it(monkeypatch):
    calls: list[str] = []
    fake(monkeypatch, verify={"isValid": False, "invalidReason": "expired"}, calls=calls)
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    payload = base64.b64encode(json.dumps({"x402Version": 2}).encode()).decode()
    out = gate.settle(payload)
    assert out.ok is False
    assert out.body["reason"] == "expired"
    assert "settle" not in calls, "settle moves money; it must not be reached"


def test_a_settled_payment_returns_the_transaction(monkeypatch):
    fake(monkeypatch)
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    payload = base64.b64encode(json.dumps({"x402Version": 2}).encode()).decode()
    out = gate.settle(payload)
    assert out.ok is True
    assert out.settlement["transaction"] == "abc123"


def test_a_bad_payment_header_is_a_402_not_a_crash(monkeypatch):
    fake(monkeypatch)
    gate = Paywall(price="0.10", pay_to=PAY_TO, api_key="k")
    out = gate.settle("!!!not base64!!!")
    assert out.ok is False
    assert out.status == 402
