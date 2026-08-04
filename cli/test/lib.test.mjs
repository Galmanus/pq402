// Unit tests for the pure helpers. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, money, caip2, parseRequirements, parsePqChallenge } from "../lib.mjs";

test("parseArgs: url and flags", () => {
  const o = parseArgs(["https://x", "--source", "bot", "--max", "0.1", "--yes"]);
  assert.equal(o.url, "https://x");
  assert.equal(o.source, "bot");
  assert.equal(o.max, 0.1);
  assert.equal(o.yes, true);
  assert.equal(o.quiet, false);
});

test("parseArgs: help with no url", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs([]).url, undefined);
});

test("money: fixed decimal, never scientific notation", () => {
  assert.equal(money(0.01), "$0.01");
  // Below Stellar's seven-decimal resolution there is nothing to show.
  assert.equal(money(5e-9), "$0.00");
  assert.equal(money(null), "?");
});

test("caip2: normalizes network aliases", () => {
  assert.equal(caip2("pubnet"), "stellar:pubnet");
  assert.equal(caip2("stellar:pubnet"), "stellar:pubnet");
  assert.equal(caip2("testnet"), "stellar:testnet");
  assert.equal(caip2(null), "stellar:testnet");
});

test("parseRequirements: reads x402 v2 body, converts 7-decimal USDC", () => {
  const body = {
    accepts: [
      {
        network: "stellar:pubnet",
        maxAmountRequired: "1000000", // 0.1 USDC at 7 decimals
        payTo: "GABC",
        asset: "USDC",
      },
    ],
  };
  const r = parseRequirements(body);
  assert.equal(r.network, "stellar:pubnet");
  assert.equal(r.usd, 0.1);
  assert.equal(r.payTo, "GABC");
});

test("parseRequirements: honors an explicit decimals field", () => {
  const body = { accepts: [{ maxAmountRequired: "1000000", decimals: 6 }] };
  assert.equal(parseRequirements(body).usd, 1); // 1e6 at 6 decimals
});

test("parseRequirements: falls back to headers when body is empty", () => {
  const headers = {
    "x-payment-network": "stellar:testnet",
    "x-payment-amount": "500000",
    "x-payment-payto": "GXYZ",
  };
  const r = parseRequirements({}, (h) => headers[h] ?? null);
  assert.equal(r.usd, 0.05);
  assert.equal(r.payTo, "GXYZ");
  assert.equal(r.network, "stellar:testnet");
});

test("parsePqChallenge: null when the 402 has no PQ headers", () => {
  assert.equal(parsePqChallenge(() => null), null);
});

test("parsePqChallenge: extracts a well-formed challenge", () => {
  const hex128 = "ab".repeat(64);
  const headers = {
    "x-pq-challenge": hex128,
    "x-pq-action": hex128,
    "x-pq-contract": "CC3L62KA",
    "x-pq-queries": "26",
  };
  const c = parsePqChallenge((h) => headers[h] ?? null);
  assert.equal(c.challenge, hex128);
  assert.equal(c.action, hex128);
  assert.equal(c.contract, "CC3L62KA");
  assert.equal(c.queries, 26);
});

test("parsePqChallenge: rejects malformed hex (wrong length, uppercase)", () => {
  const bad = { "x-pq-challenge": "ab".repeat(63), "x-pq-action": "ab".repeat(64) };
  assert.equal(parsePqChallenge((h) => bad[h] ?? null), null);
  const upper = { "x-pq-challenge": "AB".repeat(64), "x-pq-action": "ab".repeat(64) };
  assert.equal(parsePqChallenge((h) => upper[h] ?? null), null);
});

test("parseArgs: --pq-secret and --pq-prover", () => {
  const o = parseArgs(["http://x", "--pq-secret", "@/tmp/s.hex", "--pq-prover", "/bin/prove"]);
  assert.equal(o.pqSecret, "@/tmp/s.hex");
  assert.equal(o.pqProver, "/bin/prove");
});

// The v2 shape, and the reason this test exists.
//
// `parseRequirements` read only `maxAmountRequired`, the v1 field name. Against
// a v2 server it returned a null price, which printed as "?" and — the part
// that mattered — made the `--max` guard fall through its own null check. The
// cap did not apply, silently, on exactly the path the README says enforces it.

test("v2 requirements: the price is read from `amount`", () => {
  const r = parseRequirements({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1000000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GAWAG7OD4GEMQZWPQGIQDHHEUAWNJJ7VXK2VQKO3STXAJMRCNY2USAHB",
      },
    ],
  });
  assert.equal(r.usd, 0.1, "1000000 base units at seven decimals is 0.10");
  assert.equal(r.network, "stellar:testnet");
});

test("v1 requirements still parse, so a v1 server is not broken", () => {
  const r = parseRequirements({
    x402Version: 1,
    accepts: [{ maxAmountRequired: "1000000", decimals: 7, asset: "USDC" }],
  });
  assert.equal(r.usd, 0.1);
});

test("the header wins over the body, because v2 need not fill the body", () => {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [{ amount: "2500000", network: "stellar:pubnet" }] })
  ).toString("base64url");
  const r = parseRequirements({ accepts: [{ amount: "1" }] }, (h) =>
    h === "payment-required" ? header : null
  );
  assert.equal(r.usd, 0.25);
  assert.equal(r.network, "stellar:pubnet");
});

test("no price at all leaves usd null rather than guessing zero", () => {
  const r = parseRequirements({ accepts: [{}] });
  assert.equal(r.usd, null, "a guessed 0 would sail past --max, which is the bug this replaces");
});

test("money reads as money", () => {
  // "$0.1" is the sort of thing that makes someone look twice at a price they
  // should be able to glance at.
  assert.equal(money(0.1), "$0.10");
  assert.equal(money(1), "$1.00");
  assert.equal(money(12.345), "$12.345");
  // Sub-cent amounts keep their precision — an agent paying per call may well
  // be spending fractions of a cent, and rounding those to $0.00 would hide
  // the number the --max check is about to compare against.
  assert.equal(money(0.0000015), "$0.0000015");
  assert.equal(money(null), "?");
});
