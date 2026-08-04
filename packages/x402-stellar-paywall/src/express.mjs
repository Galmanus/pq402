// Express binding. One line to gate a route.
//
//   const pay = await expressPaywall({ price: "0.10", payTo: process.env.PAY_TO });
//   app.get("/premium", pay, (req, res) => res.json({ secret: "the goods" }));
//
// `req.x402` carries the settlement on success, so a handler can log the tx or
// put it in the response without knowing anything about the protocol.

import { paywall } from "./index.mjs";

export async function expressPaywall(options) {
  const gate = await paywall(options);

  return async function x402Middleware(req, res, next) {
    const requestUrl =
      options.resource?.url ??
      `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;

    const payment = gate.readPayment((h) => req.get(h));
    if (!payment) {
      res.set(gate.challengeHeader(requestUrl));
      return res.status(402).json(gate.paymentRequired(requestUrl));
    }

    const result = await gate.settle(payment);
    if (!result.ok) {
      // A refusal repeats the requirements: the client may be retrying with a
      // stale or wrong-priced payload and needs the current terms to recover.
      res.set(gate.challengeHeader(requestUrl));
      return res.status(result.status).json(result.body);
    }

    req.x402 = result.settlement;
    if (result.settlement?.transaction) {
      res.set("x-payment-response", result.settlement.transaction);
    }
    return next();
  };
}

export { paywall } from "./index.mjs";
