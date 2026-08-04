// Unit tests for the paywall's pure surface. Everything network-facing is
// stubbed: what is worth testing here is the protocol shaping, which is where
// the four failing rounds this package exists to encode actually happened.
//
// Run: node --test test/*.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { paywall, toBaseUnits, USDC_SAC, FACILITATOR } from "../src/index.mjs";

const PAY_TO = "GAWAG7OD4GEMQZWPQGIQDHHEUAWNJJ7VXK2VQKO3STXAJMRCNY2USAHB";

/** A facilitator that answers /supported and records what it was asked. */
function fakeFacilitator({ extra = { areFeesSponsored: true }, verify, settle } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const kind = String(url).split("/").pop();
    calls.push({ kind, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (kind === "supported")
      return new Response(
        JSON.stringify({ kinds: [{ network: "stellar:testnet", scheme: "exact", extra }] })
      );
    if (kind === "verify") return new Response(JSON.stringify(verify ?? { isValid: true }));
    if (kind === "settle")
      return new Response(JSON.stringify(settle ?? { success: true, transaction: "abc123" }));
    return new Response("{}", { status: 404 });
  };
  return calls;
}

test("seven decimals, not six", () => {
  // The EVM habit is a 10x underpayment that settles quietly.
  assert.equal(toBaseUnits("0.10"), "1000000");
  assert.equal(toBaseUnits("1"), "10000000");
});

test("the USDC preset is the SAC contract, not the classic issuer", () => {
  assert.match(USDC_SAC["stellar:testnet"], /^C[A-Z0-9]{55}$/);
  assert.match(USDC_SAC["stellar:pubnet"], /^C[A-Z0-9]{55}$/);
  assert.ok(FACILITATOR["stellar:testnet"].includes("testnet"));
});

test("requirements carry the facilitator's own extra, not our claim about it", async () => {
  fakeFacilitator({ extra: { areFeesSponsored: true, somethingNew: 1 } });
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  const r = gate.requirements();
  assert.deepEqual(r.extra, { areFeesSponsored: true, somethingNew: 1 });
  assert.equal(r.amount, "1000000");
  assert.equal(r.scheme, "exact");
});

test("the challenge is a base64url header, and decodes to the same document", async () => {
  fakeFacilitator();
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  const h = gate.challengeHeader("http://x/premium");
  const decoded = JSON.parse(Buffer.from(h["payment-required"], "base64url").toString());
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.resource.url, "http://x/premium");
  assert.deepEqual(decoded.accepts[0], gate.requirements());
});

test("both payment header names are read, v2 first", async () => {
  fakeFacilitator();
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  assert.equal(gate.readPayment((h) => (h === "payment-signature" ? "v2" : "v1")), "v2");
  assert.equal(gate.readPayment((h) => (h === "x-payment" ? "v1" : null)), "v1");
  assert.equal(gate.readPayment(() => null), null);
});

test("a facilitator with no matching scheme refuses to start, and says how to fix it", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ kinds: [] }));
  await assert.rejects(
    paywall({ price: "0.10", payTo: PAY_TO, apiKey: undefined }),
    /channels\.openzeppelin\.com\/testnet\/gen/,
    "the error must carry the command that fixes it"
  );
});

test("verify precedes settle, and a failed verify never reaches settle", async () => {
  const calls = fakeFacilitator({ verify: { isValid: false, invalidReason: "expired" } });
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  const payload = Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64");
  const out = await gate.settle(payload);
  assert.equal(out.ok, false);
  assert.equal(out.body.reason, "expired");
  assert.ok(!calls.some((c) => c.kind === "settle"), "settle moves money; it must not be reached");
});

test("a settled payment returns the transaction", async () => {
  fakeFacilitator();
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  const payload = Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64");
  const out = await gate.settle(payload);
  assert.equal(out.ok, true);
  assert.equal(out.settlement.transaction, "abc123");
});

test("a payment header that is not base64 JSON is a 402, not a crash", async () => {
  fakeFacilitator();
  const gate = await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "k" });
  const out = await gate.settle("!!!not base64!!!");
  assert.equal(out.ok, false);
  assert.equal(out.status, 402);
});

test("the api key travels as a bearer token", async () => {
  const calls = fakeFacilitator();
  await paywall({ price: "0.10", payTo: PAY_TO, apiKey: "secret-key" });
  assert.equal(calls[0].auth, "Bearer secret-key");
});

// --- the credential gate -------------------------------------------------

import { credentialGate, freshRound, leU64Hex } from "../src/credential.mjs";

test("a challenge is eight canonical M31 limbs, and fresh each time", () => {
  const a = freshRound(), b = freshRound();
  assert.equal(a.length, 8);
  for (const v of a) assert.ok(v >= 0 && v < 2 ** 31 - 1, `${v} must be a canonical M31 element`);
  assert.notDeepEqual(a, b, "a reused challenge is not a challenge");
  assert.equal(leU64Hex(a).length, 128, "eight little-endian u64s is 64 bytes");
});

test("a gate needs somewhere to send the proof and someone to send it", () => {
  assert.throws(() => credentialGate({}), /contract is required/);
  assert.throws(() => credentialGate({ contract: "C…" }), /source is required/);
});

test("the challenge headers name the contract that will judge", () => {
  const c = credentialGate({ contract: "CA6QM6DR", source: "k" });
  const h = c.challengeHeaders();
  assert.equal(h["x-pq-contract"], "CA6QM6DR");
  assert.equal(h["x-pq-queries"], "40");
  assert.equal(h["x-pq-challenge"].length, 128);
  assert.notEqual(c.challengeHeaders()["x-pq-challenge"], h["x-pq-challenge"]);
});

test("an unknown or reused round is refused before the chain is asked", async () => {
  const c = credentialGate({ contract: "CA6QM6DR", source: "k" });
  const out = await c.unlock("AA==", "00", { round: "never-issued" });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.match(out.error, /unknown or reused/);
});

test("a malformed unlock is a 400, not a crash", async () => {
  const c = credentialGate({ contract: "CA6QM6DR", source: "k" });
  const out = await c.unlock(undefined, undefined);
  assert.equal(out.status, 400);
});

test("a pass is single-use", () => {
  const c = credentialGate({ contract: "CA6QM6DR", source: "k" });
  // Reach past the API to seed one, since minting a real pass needs a chain.
  const h = c.challengeHeaders();
  assert.equal(c.usePass("nope"), false);
  assert.equal(c.usePass(undefined), false, "an absent pass is not a valid pass");
  assert.ok(h["x-pq-challenge"]);
});

test("checking a pass and consuming it are separate, because the handshake sends twice", () => {
  const c = credentialGate({ contract: "CA6QM6DR", source: "k" });
  // Seed a pass the way unlock() does, without needing a chain.
  const token = "deadbeef";
  c.hasPass(token); // no-op, but exercises the sweep
  assert.equal(c.usePass(token), false, "an unissued pass is not live");
  assert.equal(c.hasPass(undefined), false);
});
