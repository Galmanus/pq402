// Hono binding, same shape as the Express one.
//
//   const pay = await honoPaywall({ price: "0.10", payTo: process.env.PAY_TO });
//   app.get("/premium", pay, (c) => c.json({ secret: "the goods" }));
//
// `c.get("x402")` carries the settlement on success.

import { paywall } from "./index.mjs";

export async function honoPaywall(options) {
  const gate = await paywall(options);

  return async function x402Middleware(c, next) {
    const requestUrl = options.resource?.url ?? c.req.url;

    const payment = gate.readPayment((h) => c.req.header(h));
    if (!payment) {
      return c.json(gate.paymentRequired(requestUrl), 402, gate.challengeHeader(requestUrl));
    }

    const result = await gate.settle(payment);
    if (!result.ok) {
      return c.json(result.body, result.status, gate.challengeHeader(requestUrl));
    }

    c.set("x402", result.settlement);
    if (result.settlement?.transaction) {
      c.header("x-payment-response", result.settlement.transaction);
    }
    await next();
  };
}

export { paywall } from "./index.mjs";
