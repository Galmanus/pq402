// pq402 booth — the browser face of the demo, for the summit table.
//
// Serves ui/index.html and orchestrates the SAME flow the CLI does, against
// the running pq402 server (leaf mode) and the deployed contract:
//
//   POST /api/issue   → demo agent: fresh secret, leaf derived by the real
//                       prover, credential registered on the pq402 server
//   POST /api/pay     → 402 → prove (q=40) → unlock (REAL on-chain spend,
//                       nullifier burned) → paid 200, step-by-step timeline
//   POST /api/replay  → same proof again: server refuses; then the contract
//                       itself is asked via read-only simulation and answers
//                       false — the consensus refusal, live and free
//
// Honest scope, also printed in the UI: the demo agent's secret lives in this
// process so a booth visitor needs zero setup; in production the secret is
// client-side (see stellar agent-pay --pq-secret).
//
// Both lanes are real. The payment goes through the same `stellar agent-pay`
// plugin the terminal demo uses, so it settles on Stellar; the credential is
// judged by a deployed contract. The one read-only step is the replay check,
// which the UI labels as a simulation because that is what it is.
//
// Run:  node server.mjs &   (port 4402, leaf mode)
//       node booth.mjs      (port 4403, open in a browser)

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOOTH_PORT || 4403);
const PQ402 = process.env.PQ402_URL || "http://localhost:4402";
const PROVER = process.env.PQ_PROVER || join(HERE, "bin", "prove_action");
const CONTRACT_ID =
  process.env.PQ_CONTRACT_ID || "CA6QM6DRPVYRHFWEWNATDIKLL4P47XBI2OWVL7226WHHOTFEY2W2JKET";
// The stellar CLI's --network takes a CONFIG NAME ("testnet"); STELLAR_NETWORK
// in .env is the CAIP-2 id x402 wants ("stellar:testnet"). Reading that one
// here fails with "Invalid name", which is the same trap server.mjs fell into.
const NETWORK = process.env.PQ_NETWORK || "testnet";
const SOURCE = process.env.PQ_SOURCE || "riverrun-registry-deployer";
const WORK = join(tmpdir(), `pq402-booth-${process.pid}`);
mkdirSync(WORK, { recursive: true });

// One demo agent at a time is all a booth needs.
let agent = null; // { secret, leaf, dir, lastUnlock: {proof_b64, publics_hex} }

const sh = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1 << 24, timeout: 180_000, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve({ stdout, stderr })
    );
  });

const prove = async (secret, actionHex, roundHex, q, dir) => {
  mkdirSync(dir, { recursive: true });
  const { stdout } = await sh(PROVER, [secret, actionHex, roundHex, String(q), dir]);
  return JSON.parse(stdout.trim().split("\n").pop());
};

async function issue() {
  const t0 = Date.now();
  const secret = randomBytes(64).toString("hex");
  const dir = join(WORK, randomBytes(4).toString("hex"));
  // The leaf depends only on secret+action; a throwaway round and q=4 make
  // derivation fast. The real payment proof is q=40.
  const r402 = await fetch(`${PQ402}/premium`);
  const actionHex = r402.headers.get("x-pq-action");
  const derived = await prove(secret, actionHex, "01".padEnd(128, "0"), 4, dir);
  const reg = await fetch(`${PQ402}/pq/register`, {
    method: "POST",
    body: JSON.stringify({ leaf: derived.leaf }),
  });
  if (!reg.ok) throw new Error(`register failed: ${await reg.text()}`);
  agent = { secret, leaf: derived.leaf, dir, lastUnlock: null };
  return {
    steps: [
      { label: "secret gerado (demo: vive no booth; em produção, no cliente)", ms: 0 },
      { label: `leaf derivado pelo prover real: ${derived.leaf.slice(0, 16)}…`, ms: Date.now() - t0 },
      { label: "credencial registrada no emissor", ms: Date.now() - t0 },
    ],
    leaf: derived.leaf,
  };
}

async function pay() {
  if (!agent) throw new Error("emita uma credencial primeiro");
  const steps = [];
  const t0 = Date.now();
  const at = (label, extra = {}) => steps.push({ label, ms: Date.now() - t0, ...extra });

  const r402 = await fetch(`${PQ402}/premium`);
  const actionHex = r402.headers.get("x-pq-action");
  const roundHex = r402.headers.get("x-pq-challenge");
  at(`402 Payment Required + desafio fresco (${roundHex.slice(0, 12)}…)`);

  const tp = Date.now();
  const p = await prove(agent.secret, actionHex, roundHex, 40, agent.dir);
  const proofBytes = readFileSync(p.proof);
  at(`prova pós-quântica gerada: ${proofBytes.length.toLocaleString("pt-BR")} bytes em ${Date.now() - tp}ms (40 queries, produção)`);

  const unlockBody = {
    proof_b64: proofBytes.toString("base64"),
    publics_hex: readFileSync(p.publics).toString("hex"),
  };
  at("prova enviada; o contrato decide, não o servidor…", { pending: true });
  const un = await fetch(`${PQ402}/pq/unlock`, { method: "POST", body: JSON.stringify(unlockBody) });
  const unlock = await un.json();
  if (!un.ok) throw new Error(unlock.error || "unlock refused");
  agent.lastUnlock = unlockBody;
  writeFileSync(join(agent.dir, "last_proof.bin"), proofBytes);
  writeFileSync(join(agent.dir, "last_publics.bin"), Buffer.from(unlockBody.publics_hex, "hex"));
  at(`STARK verificado E nullifier queimado pelo consenso`, {
    tx: unlock.burn_tx,
    explorer: unlock.explorer,
    onchain: true,
  });

  // The payment goes through the CLI plugin rather than being reimplemented
  // here. x402 v2 wants signed Soroban authorization entries, and a second
  // implementation of that is a second place to get the four protocol details
  // wrong — the booth used to send the literal string "mock-settled", which
  // stopped meaning anything the day settlement became real.
  at("agente paga via x402 (entradas de autorização assinadas)…", { pending: true });
  const tpay = Date.now();
  const out = await sh("node", [
    join(HERE, "cli", "bin", "stellar-agent-pay.mjs"),
    `${PQ402}/premium`,
    "--pq-pass", unlock.pass,
    "--source", process.env.PAY_SOURCE || "pq402-payer",
    "--yes",
    "--quiet",
  ]).catch((e) => {
    throw new Error(`pagamento recusado: ${String(e.stderr || e.message).slice(0, 200)}`);
  });
  const premium = JSON.parse(out.stdout.trim());
  at(`200 — conteúdo pago entregue, liquidado em ${Date.now() - tpay}ms`, {
    tx: premium.settlement_tx,
    explorer: premium.explorer,
    onchain: true,
  });

  return { steps, premium, burn_tx: unlock.burn_tx, explorer: unlock.explorer };
}

async function replay() {
  if (!agent?.lastUnlock) throw new Error("pague uma vez primeiro");
  const steps = [];
  const t0 = Date.now();
  const at = (label, extra = {}) => steps.push({ label, ms: Date.now() - t0, ...extra });

  const un = await fetch(`${PQ402}/pq/unlock`, {
    method: "POST",
    body: JSON.stringify(agent.lastUnlock),
  });
  const body = await un.json();
  at(`servidor: ${un.status} — ${body.error || "?"}`);

  // Now the part a rogue server cannot fake: ask the CONTRACT, read-only
  // simulation (free), same wasm and storage the paid transaction used.
  const { stdout } = await sh("stellar", [
    "contract", "invoke", "--id", CONTRACT_ID, "--source", SOURCE, "--network", NETWORK,
    "--", "spend",
    "--proof-file-path", join(agent.dir, "last_proof.bin"),
    "--publics-file-path", join(agent.dir, "last_publics.bin"),
  ]);
  const verdict = stdout.trim().split("\n").pop();
  at(`contrato ${CONTRACT_ID.slice(0, 8)}… consultado direto (simulação read-only): spend → ${verdict}`, {
    onchain: true,
    refused: verdict === "false",
  });
  return { steps, chain_verdict: verdict };
}

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, `http://x`).pathname;
  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(HERE, "ui", "index.html")));
    }
    if (req.method === "POST" && path === "/api/issue") return json(res, 200, await issue());
    if (req.method === "POST" && path === "/api/pay") return json(res, 200, await pay());
    if (req.method === "POST" && path === "/api/replay") return json(res, 200, await replay());
    if (req.method === "GET" && path === "/api/config")
      return json(res, 200, { contract: CONTRACT_ID, network: NETWORK, pq402: PQ402 });
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`pq402 booth on http://localhost:${PORT} → pq402 at ${PQ402}, contract ${CONTRACT_ID} (${NETWORK})`);
});
