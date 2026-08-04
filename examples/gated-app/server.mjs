// Both gates, one configuration.
//
// This API charges 0.10 USDC AND demands an anonymous credential. Neither gate
// is implemented here: the payment settles through a facilitator and the
// credential is judged by a Soroban contract, and this file only says which.
//
//   node server.mjs
//   # register a credential, then:
//   stellar agent-pay http://localhost:4600/premium --pq-secret <hex> --yes

import express from "express";
import { expressPaywall } from "x402-stellar-paywall/express";

const app = express();
app.use(express.json({ limit: "10mb" })); // proofs are ~75 KB, base64 of them larger

const pay = await expressPaywall({
  price: "0.10",
  payTo: process.env.STELLAR_RECIPIENT,
  resource: { description: "paid and credential-gated", serviceName: "gated" },
  credential: {
    contract: process.env.PQ_CONTRACT_ID,
    source: process.env.PQ_SOURCE,
    network: process.env.PQ_NETWORK || "testnet",
  },
});

// Where proofs are traded for single-use passes.
app.post("/pq/unlock", pay.unlock);

app.get("/premium", pay, (req, res) => {
  res.json({
    premium: "paid for, and proved eligible, without saying who",
    settled_by: req.x402?.transaction ?? null,
  });
});

app.listen(4600, () =>
  console.log("gated app on http://localhost:4600/premium — payment AND credential")
);
