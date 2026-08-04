#!/usr/bin/env node
// stellar agent-pay — pay an x402/402-gated URL from the terminal.
//
// Discovered by the stellar CLI as an external subcommand: a binary named
// `stellar-agent-pay` on PATH becomes `stellar agent-pay`. It completes the
// 402 → pay → unlock loop for any agent or shell workflow, signing with a key
// that already lives in the user's `stellar keys` store — no separate wallet.
//
//   stellar agent-pay <url> [--source NAME] [--network testnet|pubnet]
//                           [--max USD] [--yes] [--quiet]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { parseArgs, money, caip2, parseRequirements, parsePqChallenge } from "../lib.mjs";

const HELP = `stellar agent-pay — pay an x402-gated URL from the terminal

USAGE:
  stellar agent-pay <url> [OPTIONS]

OPTIONS:
  --source <name>    stellar keys identity to pay from (default: $STELLAR_ACCOUNT or "default")
  --network <net>    testnet | pubnet (default: from the 402 response, else testnet)
  --max <usd>        refuse to pay more than this (e.g. 0.10). Default: no cap — you are asked.
  --yes              do not prompt for confirmation before paying
  --quiet            print only the unlocked response body
  --pq-secret <hex>  post-quantum credential secret (64-byte hex, 8 LE u64s), or
                     an @file path holding it. Needed when the 402 carries a
                     PQ challenge (riverrun binding proof, verified on-chain).
  --pq-prover <bin>  path to the prove_action binary (default: $PQ_PROVER)
  -h, --help         show this help

EXIT CODES:
  0 unlocked (paid or was free)   4 payment or settlement failed
  2 usage / no url                5 PQ credential missing or refused
  3 payment exceeds --max         6 confirmation needed, none given`;

const log = (quiet, ...m) => {
  if (!quiet) console.error(...m);
};

// Pull the secret from the user's stellar keystore. This is the integration
// that makes the plugin reusable: it signs with keys the user already manages.
function secretFrom(source) {
  const name = source || process.env.STELLAR_ACCOUNT || "default";
  try {
    return execFileSync("stellar", ["keys", "secret", name], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      `could not read secret for identity "${name}" from stellar keys. ` +
        `create one with: stellar keys generate ${name}`
    );
  }
}

// Read the 402 body exactly once (double Response.clone() is unreliable in
// undici); callers reuse the parsed body for both the requirements and the
// mock-lane flag.
async function readBody402(res) {
  try {
    return await res.json();
  } catch {
    /* some servers put requirements only in headers */
    return {};
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(HELP), 0;
  if (!o.url) return console.error(HELP), 2;

  // 1. Try the resource unpaid. Many endpoints are free; only pay on a 402.
  log(o.quiet, `→ GET ${o.url}`);
  const probe = await fetch(o.url).catch((e) => {
    throw new Error(`request failed: ${e.message}`);
  });

  if (probe.status !== 402) {
    log(o.quiet, `← ${probe.status} (no payment required)`);
    process.stdout.write(await probe.text());
    return 0;
  }

  // 2. Read what it costs, before paying.
  const body402 = await readBody402(probe);
  const req = parseRequirements(body402, (h) => probe.headers.get(h));
  const net = caip2(o.network || req.network);
  log(
    o.quiet,
    `← 402 Payment Required: ${money(req.usd)} ${req.asset} ` +
      `on ${net}${req.payTo ? ` → ${req.payTo.slice(0, 8)}…` : ""}`
  );

  // 3. Enforce the cap before any money moves.
  if (o.max != null && req.usd != null && req.usd > o.max) {
    log(o.quiet, `refused: ${money(req.usd)} exceeds --max ${money(o.max)}`);
    return 3;
  }
  if (!o.yes && req.usd != null) {
    // Distinct from 3 on purpose. "Over your budget" and "inside your budget
    // but you did not confirm" call for different reactions from a script: the
    // first should stop and alert, the second should re-run with --yes. Both
    // returning 3 made them indistinguishable to the only reader that matters.
    if (!process.stdin.isTTY) {
      log(o.quiet, `refused: would pay ${money(req.usd)} but no --yes given (non-interactive)`);
      return 6;
    }
    log(o.quiet, `about to pay ${money(req.usd)} ${req.asset}. re-run with --yes to confirm.`);
    return 6;
  }

  // 3b. Post-quantum gate: if the 402 carries a PQ challenge, prove the
  // credential (riverrun binding, M31 Circle-STARK) and trade the proof for a
  // single-use pass at /pq/unlock. The server verifies the proof against the
  // deployed Soroban contract, not local code.
  const pq = parsePqChallenge((h) => probe.headers.get(h));
  let pqPass = null;
  if (pq) {
    if (!o.pqSecret) {
      log(o.quiet, `refused: endpoint requires a PQ credential proof (pass --pq-secret)`);
      return 5;
    }
    const secret = o.pqSecret.startsWith("@")
      ? readFileSync(o.pqSecret.slice(1), "utf8").trim()
      : o.pqSecret;
    const prover = o.pqProver || process.env.PQ_PROVER;
    if (!prover) throw new Error("no prover: pass --pq-prover or set $PQ_PROVER");

    const t0 = Date.now();
    const outdir = mkdtempSync(join(tmpdir(), "pq402-"));
    const unlockUrl = new URL("/pq/unlock", o.url);
    let unlockBody;
    if (pq.mode === "relation") {
      // Full relation: binding + membership under the issuer's root. The
      // prover needs the public credential tree to build its private path.
      const relationProver =
        process.env.PQ_RELATION_PROVER || join(prover, "..", "prove_relation");
      const leaves = await (await fetch(new URL("/pq/leaves", o.url))).text();
      const leavesFile = join(outdir, "leaves.txt");
      writeFileSync(leavesFile, leaves);
      log(
        o.quiet,
        `proving FULL relation (binding q=${pq.queries} + membership q=40, root ${pq.root?.slice(0, 8)}…)…`
      );
      const line = execFileSync(
        relationProver,
        [secret, pq.action, pq.challenge, leavesFile, String(pq.queries), outdir],
        { encoding: "utf8" }
      ).trim().split("\n").pop();
      const proved = JSON.parse(line);
      log(
        o.quiet,
        `proofs: binding ${proved.binding_bytes} B + membership ${proved.membership_bytes} B in ${Date.now() - t0}ms`
      );
      unlockBody = {
        binding_b64: readFileSync(proved.binding).toString("base64"),
        membership_b64: readFileSync(proved.membership).toString("base64"),
        publics_hex: readFileSync(proved.publics).toString("hex"),
      };
    } else {
      log(o.quiet, `proving PQ credential (q=${pq.queries}, contract ${pq.contract?.slice(0, 8)}…)…`);
      const line = execFileSync(
        prover,
        [secret, pq.action, pq.challenge, String(pq.queries), outdir],
        { encoding: "utf8" }
      ).trim().split("\n").pop();
      const proved = JSON.parse(line);
      log(o.quiet, `proof: ${proved.proof_bytes} bytes in ${Date.now() - t0}ms`);
      unlockBody = {
        proof_b64: readFileSync(proved.proof).toString("base64"),
        publics_hex: readFileSync(proved.publics).toString("hex"),
      };
    }
    const unlock = await fetch(unlockUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unlockBody),
    });
    const verdict = await unlock.json();
    if (!unlock.ok) {
      log(o.quiet, `PQ unlock refused: ${verdict.error}`);
      return 5;
    }
    pqPass = verdict.pass;
    log(
      o.quiet,
      `PQ verified ON-CHAIN by ${verdict.verified_by.contract.slice(0, 8)}… ` +
        `(${verdict.verified_by.network}, ${verdict.verify_ms}ms) → pass granted`
    );
    if (verdict.burn_tx)
      log(o.quiet, `nullifier burned by consensus: ${verdict.explorer}`);
  }

  // 4a. Mock settlement lane: the server labels its payment lane mock while a
  // real facilitator key is pending; the PQ verification above is never mock.
  if (body402?.accepts?.[0]?.mock) {
    log(o.quiet, `paying… [MOCK lane, server-declared]`);
    const res = await fetch(o.url, {
      headers: { "x-payment": "mock-settled", ...(pqPass ? { "x-pq-pass": pqPass } : {}) },
    });
    if (!res.ok) {
      log(o.quiet, `← ${res.status} after payment`);
      process.stdout.write(await res.text());
      return 4;
    }
    log(o.quiet, `← 200 unlocked`);
    process.stdout.write(await res.text());
    return 0;
  }

  // 4. Pay: sign auth entries with the keystore key; the facilitator settles.
  const signer = createEd25519Signer(secretFrom(o.source), net);
  const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: net, client: new ExactStellarScheme(signer) }],
  });

  log(o.quiet, `paying…`);
  const res = await payFetch(o.url, {
    headers: pqPass ? { "x-pq-pass": pqPass } : {},
  }).catch((e) => {
    throw new Error(`payment/settlement failed: ${e.message}`);
  });
  if (!res.ok) {
    log(o.quiet, `← ${res.status} after payment`);
    process.stdout.write(await res.text());
    return 4;
  }
  log(o.quiet, `← 200 unlocked`);
  process.stdout.write(await res.text());
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`stellar agent-pay: ${e.message}`);
    process.exit(4);
  });
