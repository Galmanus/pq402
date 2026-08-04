"""A FastAPI route an agent pays for, in three lines of paywall.

    pip install -e ../../packages/x402-stellar-paywall-py[fastapi] uvicorn
    uvicorn app:app --port 4700

    stellar agent-pay http://localhost:4700/premium --max 0.10 --source pq402-payer
"""
import os

from fastapi import Depends, FastAPI

from x402_stellar_paywall.fastapi import paywall_dependency

app = FastAPI(title="paid weather")

pay = paywall_dependency(
    price="0.10",
    pay_to=os.environ["STELLAR_RECIPIENT"],
    api_key=os.environ.get("OZ_API_KEY"),
    resource={"description": "current weather", "serviceName": "weather-py"},
)


@app.get("/premium")
def premium(settlement=Depends(pay)):
    return {
        "city": "Florianópolis",
        "temp": 24,
        "settled_by": settlement.get("transaction"),
    }
