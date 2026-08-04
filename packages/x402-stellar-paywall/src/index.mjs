// x402-stellar-paywall — the framework-free core.
//
// Everything here was learned by making an x402 client and a Stellar
// facilitator agree, one failing round at a time. Four of those rounds are
// encoded as behaviour rather than documentation, because a comment does not
// stop anyone from getting it wrong:
//
//   1. v2 carries the requirements in a `payment-required` HEADER. The body is
//      read only when `x402Version === 1`. A server that publishes perfect
//      requirements in JSON alone is invisible to a v2 client, which fails
//      with "Invalid payment required response" having never looked at them.
//   2. The signed payload comes back in `PAYMENT-SIGNATURE`; `X-PAYMENT` is
//      the v1 name. Read both.
//   3. `extra.areFeesSponsored` must be present in the requirements or the
//      Stellar exact scheme refuses to build a payment. It is the
//      facilitator's claim to make, so it is fetched from `/supported` rather
//      than asserted here.
//   4. Stellar USDC has SEVEN decimals. `0.10` is `1000000` base units. The
//      six an EVM habit expects is a 10x underpayment that settles quietly.

/** USDC's Soroban Asset Contract. Not the classic `G...` issuer: the scheme
 *  invokes `transfer` on this contract, while `payTo` is the account that ends
 *  up holding the balance — which is why that account needs a trustline. */
export const USDC_SAC = {
  "stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

export const FACILITATOR = {
  "stellar:testnet": "https://channels.openzeppelin.com/x402/testnet",
  "stellar:pubnet": "https://channels.openzeppelin.com/x402",
};

/** Stellar assets carry seven decimals, not six. */
export const toBaseUnits = (human) => String(Math.round(Number(human) * 1e7));

class FacilitatorError extends Error {
  constructor(kind, status, body) {
    super(`facilitator ${kind} ${status}: ${JSON.stringify(body)}`);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

/**
 * A paywall for one price and one recipient.
 *
 * `await paywall({...})` resolves only after the facilitator has confirmed it
 * supports the scheme — so a misconfigured server fails at startup rather than
 * advertising a price it cannot settle.
 */
export async function paywall({
  price,
  payTo,
  network = "stellar:testnet",
  asset,
  facilitatorUrl,
  apiKey = process.env.OZ_API_KEY,
  maxTimeoutSeconds = 60,
  resource,
} = {}) {
  if (!price) throw new Error("paywall: price is required, e.g. price: '0.10'");
  if (!payTo) throw new Error("paywall: payTo is required (a classic G... account with a USDC trustline)");

  const url = facilitatorUrl || FACILITATOR[network];
  if (!url) throw new Error(`paywall: no facilitator preset for ${network}; pass facilitatorUrl`);
  const assetId = asset || USDC_SAC[network];
  if (!assetId) throw new Error(`paywall: no USDC preset for ${network}; pass asset`);

  const headers = () => {
    const h = { "Content-Type": "application/json" };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  };

  const call = async (kind, body) => {
    const r = await fetch(`${url}/${kind}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FacilitatorError(kind, r.status, text.slice(0, 200));
    }
    if (!r.ok) throw new FacilitatorError(kind, r.status, parsed);
    return parsed;
  };

  // Gotcha 3: ask what the facilitator supports instead of claiming it.
  const { kinds } = await call("supported", {});
  const kind = (kinds || []).find((k) => k.network === network && k.scheme === "exact");
  if (!kind) {
    throw new Error(
      `paywall: facilitator ${url} supports no exact scheme on ${network}. ` +
        (apiKey
          ? "the key may be for another network."
          : "no OZ_API_KEY set — mint one with: curl -s https://channels.openzeppelin.com/testnet/gen")
    );
  }
  const extra = kind.extra ?? {};

  const requirements = () => ({
    scheme: "exact",
    network,
    amount: toBaseUnits(price),
    asset: assetId,
    payTo,
    maxTimeoutSeconds,
    ...(Object.keys(extra).length ? { extra } : {}),
  });

  const paymentRequired = (requestUrl) => ({
    x402Version: 2,
    resource: {
      url: requestUrl,
      description: resource?.description ?? "paid resource",
      mimeType: resource?.mimeType ?? "application/json",
      ...(resource?.serviceName ? { serviceName: resource.serviceName } : {}),
    },
    accepts: [requirements()],
  });

  /** Gotcha 1: the requirements travel as a base64 header. */
  const challengeHeader = (requestUrl) => ({
    "payment-required": Buffer.from(JSON.stringify(paymentRequired(requestUrl))).toString(
      "base64url"
    ),
  });

  /** Gotcha 2: v2 signs into PAYMENT-SIGNATURE, v1 into X-PAYMENT. */
  const readPayment = (getHeader) =>
    getHeader("payment-signature") || getHeader("x-payment") || null;

  /**
   * Verify, then settle. In that order and never the other: settle moves
   * money, so a payload that fails verification must not reach it.
   *
   * Returns `{ ok: true, settlement }` or `{ ok: false, status, body }` — the
   * caller decides how to render a refusal, but never has to guess why.
   */
  const settle = async (encodedPayment) => {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayment, "base64").toString("utf8"));
    } catch {
      return { ok: false, status: 402, body: { error: "payment header is not base64 JSON" } };
    }
    const envelope = {
      x402Version: payload.x402Version ?? 2,
      paymentPayload: payload,
      paymentRequirements: payload.accepted ?? requirements(),
    };
    try {
      const v = await call("verify", envelope);
      if (v.isValid === false)
        return { ok: false, status: 402, body: { error: "payment rejected", reason: v.invalidReason ?? v } };
      const s = await call("settle", envelope);
      if (s.success === false)
        return { ok: false, status: 402, body: { error: "settlement failed", reason: s } };
      return { ok: true, settlement: s };
    } catch (e) {
      return { ok: false, status: 502, body: { error: String(e.message || e) } };
    }
  };

  return {
    network,
    price,
    payTo,
    asset: assetId,
    facilitator: url,
    extra,
    requirements,
    paymentRequired,
    challengeHeader,
    readPayment,
    settle,
  };
}
