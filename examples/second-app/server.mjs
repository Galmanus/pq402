// A second, unrelated app — gated in one line.
//
// This exists to answer the only question that matters about a middleware kit:
// does it gate something that is NOT the app it was extracted from? There is no
// post-quantum credential here, no prover, no riverrun. Just a weather API that
// costs a tenth of a dollar.
//
//   node server.mjs
//   stellar agent-pay http://localhost:4500/weather --max 0.10 --source pq402-payer

import express from "express";
import { expressPaywall } from "x402-stellar-paywall/express";

const app = express();

const pay = await expressPaywall({
  price: "0.10",
  payTo: process.env.STELLAR_RECIPIENT,
  resource: { description: "current weather", serviceName: "weather" },
});

app.get("/weather", pay, (req, res) => {
  res.json({
    city: "Florianópolis",
    temp: 24,
    conditions: "Sunny",
    settled_by: req.x402?.transaction ?? null,
  });
});

app.listen(4500, () =>
  console.log("second app on http://localhost:4500/weather — gated by x402-stellar-paywall")
);
