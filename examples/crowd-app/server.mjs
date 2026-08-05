// An API that charges you and checks you belong — and cannot tell who you are.
//
// The difference from examples/gated-app is one word in the config: mode
// "crowd". That swaps the identifying credential for the unlinkable one. The
// server learns that SOMEONE in the issuer's set paid; it never learns which
// member, and two payments by the same credential share no public value, so
// they cannot be linked to each other either.
//
// The challenge is not this server's to choose. `act` derives the expected
// round from the ledger sequence and refuses anything else, so the freshness
// of the proof is guaranteed by consensus rather than by whoever is asking.

import express from "express";
import { expressPaywall } from "x402-stellar-paywall/express";

const app = express();
app.use(express.json({ limit: "20mb" })); // two proofs, ~200 KB together

const pay = await expressPaywall({
  price: "0.10",
  payTo: process.env.STELLAR_RECIPIENT,
  resource: { description: "paid, and provably eligible, anonymously", serviceName: "crowd" },
  credential: {
    mode: "crowd",
    actContract: process.env.CROWD_ACT_CONTRACT,
    membershipContract: process.env.CROWD_MEMBERSHIP_CONTRACT,
    root: process.env.CROWD_ROOT,
    source: process.env.PQ_SOURCE,
    network: process.env.PQ_NETWORK || "testnet",
  },
});

app.post("/pq/unlock", pay.unlock);

app.get("/premium", pay, (req, res) => {
  res.json({
    premium: "paid for by a member of the set, and the set is all this server knows",
    settled_by: req.x402?.transaction ?? null,
  });
});

const PORT = Number(process.env.PORT || 4800);
app.listen(PORT, () =>
  console.log(`crowd app on http://localhost:${PORT}/premium — anonymous membership + payment`)
);
