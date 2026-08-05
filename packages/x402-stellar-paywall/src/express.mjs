// Express binding. One line to gate a route by payment, and optionally by an
// anonymous credential as well.
//
//   const pay = await expressPaywall({ price: "0.10", payTo: process.env.PAY_TO });
//   app.get("/premium", pay, (req, res) => res.json({ secret: "the goods" }));
//
// `req.x402` carries the settlement on success, so a handler can log the tx or
// return it without knowing anything about the protocol.
//
// With a credential gate, the route additionally demands a zero-knowledge proof
// that the caller holds a credential, judged by a Soroban contract:
//
//   const pay = await expressPaywall({
//     price: "0.10",
//     payTo: process.env.PAY_TO,
//     credential: { contract: "CA6QM6DR…", source: "my-key" },
//   });
//   app.post("/pq/unlock", pay.unlock);   // where proofs are traded for passes
//   app.get("/premium", pay, handler);
//
// The two gates are independent and the ordering is deliberate: the credential
// is checked first, so a caller who would be refused never gets charged.

import { paywall } from "./index.mjs";
import { credentialGate } from "./credential.mjs";
import { crowdGate } from "./crowd.mjs";

export async function expressPaywall(options) {
  const gate = await paywall(options);
  // `credential.mode: "crowd"` swaps the identifying gate for the unlinkable
  // one: the server learns that someone in the issuer's set paid, never which
  // member, and two payments by one credential share no public value.
  const cred = options.credential
    ? options.credential.mode === "crowd"
      ? crowdGate(options.credential)
      : credentialGate(options.credential)
    : null;

  const middleware = async function x402Middleware(req, res, next) {
    const requestUrl =
      options.resource?.url ??
      `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;

    // The credential first. Charging someone and then refusing them is worse
    // than refusing them, and it is the server's job not to arrange that.
    const passToken = req.get("x-pq-pass");
    if (cred && !cred.hasPass(passToken)) {
      // The crowd gate's requirement is async: it reads the round from the
      // ledger, because the round is not the server's to choose.
      const requirement = await cred.requirement();
      res.set({
        ...gate.challengeHeader(requestUrl),
        ...(cred.challengeHeaders ? cred.challengeHeaders() : {}),
      });
      return res.status(402).json({
        ...gate.paymentRequired(requestUrl),
        pq_required: { unlock: "POST /pq/unlock", ...requirement },
      });
    }

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

    // Only now. The credential is spent when the request succeeds, not when it
    // is first presented, because the handshake presents it twice.
    if (cred) cred.usePass(passToken);

    req.x402 = result.settlement;
    if (result.settlement?.transaction) {
      res.set("x-payment-response", result.settlement.transaction);
    }
    return next();
  };

  /**
   * The unlock endpoint, mounted wherever you like. Takes
   * `{ proof_b64, publics_hex }` and answers with a single-use pass, or with
   * the contract's refusal.
   */
  middleware.unlock = async function x402Unlock(req, res) {
    if (!cred) return res.status(404).json({ error: "no credential gate configured" });
    const body = req.body ?? {};
    const verdict =
      cred.kind === "crowd"
        ? await cred.unlock(body)
        : await cred.unlock(body.proof_b64, body.publics_hex, { round: body.round });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
    return res.json({
      pass: verdict.pass,
      ...(verdict.commitment && { commitment: verdict.commitment }),
      verified_by: {
        contract: cred.contract,
        network: cred.network,
        ...(verdict.mode ? { mode: verdict.mode } : { mode: cred.kind ?? "binding" }),
      },
      ...(verdict.tx && {
        burn_tx: verdict.tx,
        explorer: `https://stellar.expert/explorer/${cred.network}/tx/${verdict.tx}`,
      }),
    });
  };

  middleware.gate = gate;
  middleware.credential = cred;
  return middleware;
}

export { paywall } from "./index.mjs";
export { credentialGate } from "./credential.mjs";
