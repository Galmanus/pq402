// pq402 — an x402 paywall whose unlock requires a post-quantum credential proof
// verified by a real Soroban contract on Stellar testnet.
//
//   GET  /premium              → 402 + x402 requirements + PQ challenge headers
//   POST /pq/unlock            → {proof_b64, publics_hex} → on-chain verify → single-use pass
//   GET  /premium (+pass +payment) → 200 premium content
//
// The proof is riverrun's binding relation (M31 Circle-STARK, hash-based, no
// trusted setup): leaf = permute(secret ‖ action), nullifier = permute(secret ‖
// round). The server checks leaf ∈ credential registry, round = the challenge
// it issued, nullifier never seen before (anti-replay), and then asks the
// deployed m31-verify contract — not local code — whether the proof stands.
//
// Honest scope. The leaf is a public input, so the server knows WHICH
// credential paid; hiding that — membership under a root with a private path —
// is documented roadmap, not shipped here.
//
// BOTH lanes are real by default. The payment settles through the facilitator
// and the credential is judged by a deployed contract. MOCK_PAYMENT=1 opts
// into a settlement stub for demoing the proof lane with no key and no funded
// wallet, and when it is on the 402 says so in its own body; the PQ lane has
// no stub at all.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4402);
// The stellar CLI's --network takes a CONFIG NAME ("testnet"), while x402
// takes a CAIP-2 id ("stellar:testnet"). They are different namespaces and
// feeding one to the other fails with "Invalid name". Kept separate on
// purpose; X402_NETWORK above is the CAIP-2 one.
const NETWORK = process.env.PQ_NETWORK || "testnet";
const CONTRACT_ID =
  process.env.PQ_CONTRACT_ID || "CA6QM6DRPVYRHFWEWNATDIKLL4P47XBI2OWVL7226WHHOTFEY2W2JKET";
const NUM_QUERIES = Number(process.env.PQ_QUERIES || 40);
const SOURCE = process.env.PQ_SOURCE || "riverrun-registry-deployer";
const PRICE_USD = process.env.PRICE_USD || "0.10";
// The payment lane is REAL by default now. MOCK_PAYMENT=1 opts back into the
// stub, which exists only so the PQ lane can be demoed with no facilitator key
// and no funded wallet. The PQ lane was never mocked either way.
const MOCK_PAYMENT = process.env.MOCK_PAYMENT === "1";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://channels.openzeppelin.com/x402/testnet";
const OZ_API_KEY = process.env.OZ_API_KEY || "";
// USDC's Soroban Asset Contract on testnet. NOT the classic issuer G...: the
// scheme invokes `transfer` on this contract, while `payTo` below is the
// classic account that ends up holding the balance.
const USDC_SAC =
  process.env.USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = process.env.STELLAR_RECIPIENT || "";
const X402_NETWORK = process.env.X402_NETWORK || "stellar:testnet";
/// Price in USDC base units. Stellar USDC carries SEVEN decimals, not the six
/// an EVM habit expects; getting this wrong is a 10x payment.
const PRICE_BASE_UNITS = String(Math.round(Number(PRICE_USD) * 1e7));

/// What the facilitator says it supports, discovered once at startup rather
/// than hardcoded. The `extra` block travels into the requirements: the Stellar
/// exact scheme refuses to build a payment unless it finds
/// `areFeesSponsored: true` there, and that flag is the facilitator's to
/// assert, not ours to claim on its behalf. A server that hardcodes it lies
/// the moment the facilitator changes its mind.
let SUPPORTED_EXTRA = null;

async function discoverFacilitator() {
  const headers = { "Content-Type": "application/json" };
  if (OZ_API_KEY) headers.Authorization = `Bearer ${OZ_API_KEY}`;
  const r = await fetch(`${FACILITATOR_URL}/supported`, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (!r.ok) throw new Error(`facilitator /supported ${r.status}: ${await r.text()}`);
  const { kinds } = await r.json();
  const kind = (kinds || []).find(
    (k) => k.network === X402_NETWORK && k.scheme === "exact"
  );
  if (!kind)
    throw new Error(`facilitator supports no exact scheme on ${X402_NETWORK}`);
  SUPPORTED_EXTRA = kind.extra ?? {};
  return SUPPORTED_EXTRA;
}

/// One x402 accepts-entry, the shape the v2 schema validates against.
function paymentRequirements() {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: PRICE_BASE_UNITS,
    asset: USDC_SAC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    ...(SUPPORTED_EXTRA ? { extra: SUPPORTED_EXTRA } : {}),
  };
}

/// The v2 requirements, as the base64 header a v2 client actually reads. The
/// body copy is for humans and v1; a client that finds no header concludes the
/// endpoint is not x402 at all.
function paymentRequiredHeader(port) {
  const pr = {
    x402Version: 2,
    resource: {
      url: `http://localhost:${port}/premium`,
      description: "post-quantum-gated paid API",
      mimeType: "application/json",
      serviceName: "pq402",
    },
    accepts: [MOCK_PAYMENT ? { ...paymentRequirements(), mock: true } : paymentRequirements()],
  };
  return { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64url") };
}

/// Ask the facilitator to check, then to settle. Returns the settlement body
/// on success and throws with the facilitator's own words on failure, because
/// a paywall that swallows the reason it refused is unusable.
async function facilitate(kind, paymentPayload) {
  const headers = { "Content-Type": "application/json" };
  if (OZ_API_KEY) headers.Authorization = `Bearer ${OZ_API_KEY}`;
  const r = await fetch(`${FACILITATOR_URL}/${kind}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version ?? 2,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted ?? paymentRequirements(),
    }),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`facilitator ${kind} ${r.status}: ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`facilitator ${kind} ${r.status}: ${JSON.stringify(body)}`);
  return body;
}
// PQ_SPEND=1 (default): unlock submits a real `spend` transaction, so the
// nullifier burns in contract storage and single-use is enforced by the
// chain. PQ_SPEND=0 falls back to a read-only `verify_q` simulation with the
// in-process nullifier set (free, but the server is the replay authority).
const SPEND_ON_CHAIN = process.env.PQ_SPEND !== "0";

// PQ_MODE=relation upgrades the credential check from "leaf in a server-side
// list" to the FULL riverrun relation: the agent also proves, in a second
// STARK, that its leaf digest sits under the issuer's Merkle ROOT via a
// private path, and the contract checks both proofs composed by the shared
// leaf. The server then holds no allowlist at unlock time: the root is the
// authority and the chain enforces it. Binding runs at 36 FRI queries, the
// measured maximum that fits the composed relation in one transaction
// (labeled tradeoff; production 40+40 is a two-transaction flow).
const RELATION_MODE = process.env.PQ_MODE === "relation";
const RELATION_CONTRACT =
  process.env.PQ_RELATION_CONTRACT || "CDTZAJBY3WAHBXLOXQSMP4AATKJE2OH6H6THXM7TON7377KBVUDD76BX";
const RELATION_BINDING_Q = Number(process.env.PQ_RELATION_BINDING_Q || 36);
const TREE_TOOL =
  process.env.PQ_TREE_TOOL ||
  join(process.env.HOME || "", "projects/mirror-pool/crates/riverrun-m31/target/release/examples/tree_root");

// Fixed action id for this resource: "premium-api-access", 8 M31 elements.
// Reduced below 2^31-1 so prover and verifier agree byte-for-byte.
export const ACTION = actionFromLabel("premium-api-access");

// Credential registry: leaves issued to agents. Loaded from a JSON file
// (array of hex leaves) or seeded via POST /pq/register in demo mode.
const registry = new Set(
  process.env.PQ_REGISTRY ? JSON.parse(readFileSync(process.env.PQ_REGISTRY, "utf8")) : []
);
const challenges = new Map(); // roundHex → issued_at (single use)
const nullifiers = new Set(); // spent, forever
const passes = new Map(); // token → {leaf, at} (single use)

// Relation mode: a 16-slot credential tree of leaf DIGESTS (64-byte hex
// each). Empty slots hold arbitrary distinct placeholder digests; issuing a
// credential writes the next slot and recomputes the root with the same
// Poseidon2 compression the proofs use (shelled out, JS has no M31).
const tree = Array.from({ length: 16 }, (_, i) =>
  leU64Hex(Array.from({ length: 8 }, (_, j) => 900000 + i * 8 + j))
);
let treeNext = 0;
let treeRoot = null;

function recomputeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pq402-tree-"));
  const file = join(dir, "leaves.txt");
  writeFileSync(file, tree.join("\n") + "\n");
  return new Promise((resolve, reject) => {
    execFile(TREE_TOOL, [file], { timeout: 30_000 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) return reject(new Error(`tree_root failed: ${err.message}`));
      treeRoot = stdout.trim();
      resolve(treeRoot);
    });
  });
}

function actionFromLabel(label) {
  // 8 M31 elements derived from the label bytes; stable and < 2^31 - 1.
  const out = [];
  for (let i = 0; i < 8; i++) {
    let acc = 0;
    for (let j = 0; j < label.length; j++) {
      acc = (acc * 33 + label.charCodeAt(j) + i * 131) % 0x7ffffffe;
    }
    out.push(acc);
  }
  return out;
}

function leU64Hex(vals) {
  return vals
    .map((v) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(v));
      return b.toString("hex");
    })
    .join("");
}

function freshRound() {
  // 8 random M31 elements (each < 2^31 - 1).
  const vals = [];
  while (vals.length < 8) {
    const v = randomBytes(4).readUInt32LE(0) & 0x7fffffff;
    if (v < 0x7fffffff) vals.push(v);
  }
  return vals;
}

// Split 448-byte relation publics (56 LE u64s): action ‖ round ‖ leaf ‖
// nullifier ‖ root.
export function splitRelationPublics(hex) {
  // action[8] ‖ round[8] ‖ leaf[8] ‖ nullifier[8] ‖ root[8] = 40 limbs.
  // leaf and nullifier are DIGESTS. They were the full sixteen-limb
  // permutation states, which published the witness: the permutation is a
  // bijection and the context is public beside it.
  if (hex.length !== 640) return null;
  const buf = Buffer.from(hex, "hex");
  const u64s = [];
  for (let i = 0; i < 40; i++) u64s.push(buf.readBigUInt64LE(i * 8));
  return {
    action: u64s.slice(0, 8),
    round: u64s.slice(8, 16),
    leafHex: buf.subarray(16 * 8, 24 * 8).toString("hex"),
    nullifierHex: buf.subarray(24 * 8, 32 * 8).toString("hex"),
    rootHex: buf.subarray(32 * 8).toString("hex"),
  };
}

// Split 256-byte publics (32 LE u64s) into the four fields:
// action[8] ‖ round[8] ‖ leaf[8] ‖ nullifier[8], the last two being digests.
export function splitPublics(hex) {
  if (hex.length !== 512) return null;
  const u64s = [];
  const buf = Buffer.from(hex, "hex");
  for (let i = 0; i < 32; i++) u64s.push(buf.readBigUInt64LE(i * 8));
  return {
    action: u64s.slice(0, 8),
    round: u64s.slice(8, 16),
    leafHex: buf.subarray(16 * 8, 24 * 8).toString("hex"),
    nullifierHex: buf.subarray(24 * 8).toString("hex"),
  };
}

// The one non-negotiable step: ask the DEPLOYED contract. Read-only simulation
// against testnet RPC — free, but the same wasm, same cost model, same verdict
// a paid transaction would produce (proven by tx 35f752bb… on this contract).
function verifyOnChain(proofHex, publicsHex) {
  // A production proof is ~75KB → 150KB of hex, past Linux's 128KB per-arg
  // exec limit, so both Bytes args go in as raw-byte files.
  //
  // Two modes. spend (default): a REAL transaction that verifies the STARK
  // and burns the nullifier in contract storage, single-use by consensus;
  // `spend` verifies at production security (40 queries), so it requires the
  // proof to be q=40. verify_q (PQ_SPEND=0): read-only simulation, free.
  const dir = mkdtempSync(join(tmpdir(), "pq402-verify-"));
  const proofPath = join(dir, "proof.bin");
  const publicsPath = join(dir, "publics.bin");
  writeFileSync(proofPath, Buffer.from(proofHex, "hex"));
  writeFileSync(publicsPath, Buffer.from(publicsHex, "hex"));
  const spend = SPEND_ON_CHAIN && NUM_QUERIES === 40;
  const args = [
    "contract", "invoke", "--id", CONTRACT_ID, "--source", SOURCE,
    "--network", NETWORK,
    ...(spend
      ? ["--send=yes", "--", "spend"]
      : ["--", "verify_q"]),
    "--proof-file-path", proofPath, "--publics-file-path", publicsPath,
    ...(spend ? [] : ["--num-queries", String(NUM_QUERIES)]),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "stellar", args,
      { maxBuffer: 1 << 22, timeout: 120_000 },
      (err, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        if (err) return reject(new Error(`on-chain verify failed to run: ${err.message}`));
        const ok = stdout.trim().split("\n").pop() === "true";
        const tx = (stderr.match(/tx\/([0-9a-f]{64})/) || [])[1] || null;
        resolve({ ok, mode: spend ? "spend" : "verify_q", tx });
      }
    );
  });
}

// Relation mode's on-chain step: one transaction that verifies BOTH proofs
// (binding at RELATION_BINDING_Q, membership at production 40), checks the
// shared-leaf composition, and burns the nullifier.
function spendRelationOnChain(bindingHex, membershipHex, publicsHex) {
  const dir = mkdtempSync(join(tmpdir(), "pq402-relation-"));
  const bPath = join(dir, "binding.bin");
  const mPath = join(dir, "membership.bin");
  const pPath = join(dir, "publics.bin");
  writeFileSync(bPath, Buffer.from(bindingHex, "hex"));
  writeFileSync(mPath, Buffer.from(membershipHex, "hex"));
  writeFileSync(pPath, Buffer.from(publicsHex, "hex"));
  return new Promise((resolve, reject) => {
    execFile(
      "stellar",
      [
        "contract", "invoke", "--id", RELATION_CONTRACT, "--source", SOURCE,
        "--network", NETWORK, "--send=yes", "--", "spend_relation_q",
        "--binding-file-path", bPath, "--membership-file-path", mPath,
        "--publics-file-path", pPath, "--binding-q", String(RELATION_BINDING_Q),
      ],
      { maxBuffer: 1 << 22, timeout: 120_000 },
      (err, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        if (err) return reject(new Error(`on-chain relation spend failed to run: ${err.message}`));
        const ok = stdout.trim().split("\n").pop() === "true";
        const tx = (stderr.match(/tx\/([0-9a-f]{64})/) || [])[1] || null;
        resolve({ ok, mode: "spend_relation", tx });
      }
    );
  });
}

const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj, null, 2));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1 << 21) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    return json(res, 200, {
      service: "pq402 — post-quantum-gated paid API",
      price: `$${PRICE_USD} USDC (x402)${MOCK_PAYMENT ? " [payment MOCK in this run]" : ""}`,
      pq: {
        relation: "riverrun binding (M31 Circle-STARK, hash-based, no trusted setup)",
        verifier_contract: CONTRACT_ID,
        network: NETWORK,
        num_queries: NUM_QUERIES,
        note: "proof verified by the deployed contract, never by server-local code",
      },
      flow: "GET /premium → 402+challenge → POST /pq/unlock {proof_b64, publics_hex} → pass → GET /premium",
    });
  }

  // Demo-mode credential issuance. In production this is the issuer's job.
  // Leaf mode registers the full 128-byte leaf into a server-side set;
  // relation mode writes the 64-byte leaf DIGEST into the Merkle tree and
  // recomputes the root that the chain will enforce.
  if (req.method === "POST" && url.pathname === "/pq/register") {
    const body = JSON.parse(await readBody(req));
    if (RELATION_MODE) {
      const digest = body.digest || (body.leaf || "").slice(0, 128);
      if (!/^[0-9a-f]{128}$/.test(digest))
        return json(res, 400, { error: "digest must be 64 bytes hex (or send a 128-byte leaf)" });
      if (treeNext >= tree.length) return json(res, 409, { error: "credential tree is full (16 slots)" });
      tree[treeNext++] = digest;
      await recomputeRoot();
      return json(res, 200, {
        registered: digest.slice(0, 16) + "…",
        slot: treeNext - 1,
        root: treeRoot,
      });
    }
    const { leaf } = body;
    // The leaf is a DIGEST — eight Mersenne-31 limbs, 64 bytes. It used to be
    // the full sixteen-limb permutation state, which published the witness:
    // the permutation is a bijection and the context is public beside it, so
    // inverting on the published leaf returned the credential secret.
    if (!/^[0-9a-f]{128}$/.test(leaf || ""))
      return json(res, 400, { error: "leaf must be 64 bytes hex (8 M31 limbs)" });
    registry.add(leaf);
    return json(res, 200, { registered: leaf.slice(0, 16) + "…", registry_size: registry.size });
  }

  // Relation mode: the public credential tree, one digest per line. The
  // prover reads this to build its own (private) authentication path.
  if (req.method === "GET" && url.pathname === "/pq/leaves") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(tree.join("\n") + "\n");
  }

  if (req.method === "POST" && url.pathname === "/pq/unlock") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }

    if (RELATION_MODE) {
      const bindingHex = body.binding_b64 && Buffer.from(body.binding_b64, "base64").toString("hex");
      const membershipHex =
        body.membership_b64 && Buffer.from(body.membership_b64, "base64").toString("hex");
      const p = splitRelationPublics(body.publics_hex || "");
      if (!bindingHex || !membershipHex || !p)
        return json(res, 400, { error: "need binding_b64, membership_b64 and 896-hex publics_hex" });

      if (leU64Hex(p.action.map(Number)) !== leU64Hex(ACTION))
        return json(res, 403, { error: "action mismatch: proof is not for this resource" });
      const roundHex = leU64Hex(p.round.map(Number));
      if (!challenges.delete(roundHex))
        return json(res, 403, { error: "unknown or reused challenge round" });
      if (p.rootHex !== treeRoot)
        return json(res, 403, { error: "root mismatch: proof is not against the current credential tree" });
      if (nullifiers.has(p.nullifierHex))
        return json(res, 403, { error: "nullifier already spent (replay)" });

      const t0 = Date.now();
      let verdict;
      try {
        verdict = await spendRelationOnChain(bindingHex, membershipHex, body.publics_hex);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
      if (!verdict.ok)
        return json(res, 403, {
          error: "contract refused the relation spend (invalid proof or nullifier already burned on-chain)",
        });

      nullifiers.add(p.nullifierHex);
      const token = randomBytes(16).toString("hex");
      passes.set(token, { leaf: p.leafHex, at: Date.now() });
      return json(res, 200, {
        pass: token,
        verified_by: {
          contract: RELATION_CONTRACT,
          network: NETWORK,
          mode: "spend_relation",
          binding_q: RELATION_BINDING_Q,
          membership_q: 40,
        },
        ...(verdict.tx && {
          burn_tx: verdict.tx,
          explorer: `https://stellar.expert/explorer/${NETWORK}/tx/${verdict.tx}`,
        }),
        verify_ms: Date.now() - t0,
        nullifier: p.nullifierHex.slice(0, 16) + "…",
      });
    }

    const proofHex = body.proof_hex || (body.proof_b64 && Buffer.from(body.proof_b64, "base64").toString("hex"));
    const p = splitPublics(body.publics_hex || "");
    if (!proofHex || !p) return json(res, 400, { error: "need proof_hex|proof_b64 and 768-hex publics_hex" });

    // Cheap checks first, exact reason on every refusal.
    if (leU64Hex(p.action.map(Number)) !== leU64Hex(ACTION))
      return json(res, 403, { error: "action mismatch: proof is not for this resource" });
    const roundHex = leU64Hex(p.round.map(Number));
    if (!challenges.delete(roundHex))
      return json(res, 403, { error: "unknown or reused challenge round" });
    if (!registry.has(p.leafHex))
      return json(res, 403, { error: "leaf not in credential registry" });
    if (nullifiers.has(p.nullifierHex))
      return json(res, 403, { error: "nullifier already spent (replay)" });

    const t0 = Date.now();
    let verdict;
    try {
      verdict = await verifyOnChain(proofHex, body.publics_hex);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
    if (!verdict.ok)
      return json(res, 403, {
        error:
          verdict.mode === "spend"
            ? "contract refused the spend (invalid proof or nullifier already burned on-chain)"
            : "on-chain verifier rejected the proof",
      });

    nullifiers.add(p.nullifierHex); // fast-path cache; the chain is the authority in spend mode
    const token = randomBytes(16).toString("hex");
    passes.set(token, { leaf: p.leafHex, at: Date.now() });
    return json(res, 200, {
      pass: token,
      verified_by: { contract: CONTRACT_ID, network: NETWORK, num_queries: NUM_QUERIES, mode: verdict.mode },
      ...(verdict.tx && {
        burn_tx: verdict.tx,
        explorer: `https://stellar.expert/explorer/${NETWORK}/tx/${verdict.tx}`,
      }),
      verify_ms: Date.now() - t0,
      nullifier: p.nullifierHex.slice(0, 16) + "…",
    });
  }

  if (req.method === "GET" && url.pathname === "/premium") {
    const pass = req.headers["x-pq-pass"];
    // v2 sends the signed payload in PAYMENT-SIGNATURE; X-PAYMENT is the v1
    // name and is still accepted so a v1 client is not broken by this server.
    const payment =
      req.headers["payment-signature"] || req.headers["x-payment"];
    if (pass && passes.has(pass)) {
      if (!payment)
        return json(
          res, 402,
          { error: "pass ok, payment missing", mock: MOCK_PAYMENT },
          paymentRequiredHeader(PORT)
        );

      let settlement = null;
      if (MOCK_PAYMENT) {
        if (payment !== "mock-settled")
          return json(
            res, 402,
            { error: "pass ok, payment missing", mock: true },
            paymentRequiredHeader(PORT)
          );
      } else {
        // Real lane: decode the client's signed auth entries, have the
        // facilitator check them, and only then have it settle on Stellar.
        // Verify before settle is not ceremony — settle moves money, and a
        // payload that fails verification must never reach it.
        let paymentPayload;
        try {
          paymentPayload = JSON.parse(Buffer.from(payment, "base64").toString("utf8"));
        } catch {
          return json(res, 402, { error: "X-PAYMENT is not base64 JSON" });
        }
        try {
          const v = await facilitate("verify", paymentPayload);
          if (v.isValid === false)
            return json(res, 402, { error: "payment rejected", reason: v.invalidReason ?? v });
          settlement = await facilitate("settle", paymentPayload);
          if (settlement.success === false)
            return json(res, 402, { error: "settlement failed", reason: settlement });
        } catch (e) {
          return json(res, 502, { error: String(e.message || e) });
        }
      }

      const { leaf } = passes.get(pass);
      passes.delete(pass); // single use
      return json(res, 200, {
        premium: "the goods: one paid, PQ-authenticated API response",
        credential: leaf.slice(0, 16) + "…",
        payment: MOCK_PAYMENT
          ? "MOCK (opt-in via MOCK_PAYMENT=1)"
          : "x402 settled on Stellar",
        ...(settlement?.transaction && {
          settlement_tx: settlement.transaction,
          explorer: `https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`,
        }),
        pq_verified_on: {
          contract: RELATION_MODE ? RELATION_CONTRACT : CONTRACT_ID,
          network: NETWORK,
          ...(RELATION_MODE && { relation: "binding + membership under the issuer root" }),
        },
      });
    }
    // 402 with both the x402 shape and the PQ challenge.
    const round = freshRound();
    const roundHex = leU64Hex(round);
    challenges.set(roundHex, Date.now());
    // v2 carries the requirements in a PAYMENT-REQUIRED header, base64 of the
    // same JSON. The body is only read for v1, so a server that publishes the
    // requirements in the body alone is invisible to a v2 client — it fails
    // with "Invalid payment required response" having never looked at them.
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: `http://localhost:${PORT}/premium`,
        description: "post-quantum-gated paid API",
        mimeType: "application/json",
        serviceName: "pq402",
      },
      accepts: [
        MOCK_PAYMENT ? { ...paymentRequirements(), mock: true } : paymentRequirements(),
      ],
    };
    return json(
      res, 402,
      {
        x402Version: 2,
        resource: {
          url: `http://localhost:${PORT}/premium`,
          description: "post-quantum-gated paid API",
          mimeType: "application/json",
          serviceName: "pq402",
        },
        accepts: [
          MOCK_PAYMENT
            ? { ...paymentRequirements(), mock: true }
            : paymentRequirements(),
        ],
        pq_required: RELATION_MODE
          ? {
              relation: "riverrun-full-relation-m31",
              contract: RELATION_CONTRACT,
              network: NETWORK,
              binding_q: RELATION_BINDING_Q,
              membership_q: 40,
              leaves: "GET /pq/leaves",
              unlock: "POST /pq/unlock",
            }
          : {
              relation: "riverrun-binding-m31",
              contract: CONTRACT_ID,
              network: NETWORK,
              num_queries: NUM_QUERIES,
              unlock: "POST /pq/unlock",
            },
      },
      {
        ...(RELATION_MODE
          ? {
            "x-pq-action": leU64Hex(ACTION),
            "x-pq-challenge": roundHex,
            "x-pq-contract": RELATION_CONTRACT,
            "x-pq-queries": String(RELATION_BINDING_Q),
            "x-pq-mode": "relation",
            "x-pq-root": treeRoot,
          }
        : {
            "x-pq-action": leU64Hex(ACTION),
            "x-pq-challenge": roundHex,
            "x-pq-contract": CONTRACT_ID,
            "x-pq-queries": String(NUM_QUERIES),
          }),
        // The v2 requirements ride here, not in the body.
        "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString(
          "base64url"
        ),
      }
    );
  }

  json(res, 404, { error: "not found" });
});

async function boot() {
  if (RELATION_MODE) {
    // The relation verifier still carries the OLD public layout: leaf and
    // nullifier as full sixteen-limb permutation states, which is the shape
    // that published the witness. The binding path was rebuilt and redeployed;
    // this one has not been. Refusing is better than accepting a proof under a
    // relation this repo no longer stands behind.
    console.error(
      "PQ_MODE=relation is disabled: its verifier predates the digest fix " +
        "(see 'Honest limits' in the README) and needs rebuilding and " +
        "redeploying against the repaired relation. Use the default binding mode."
    );
    process.exit(1);
  }
  if (!MOCK_PAYMENT) {
    try {
      const extra = await discoverFacilitator();
      console.log(
        `facilitator ${FACILITATOR_URL} → exact/${X402_NETWORK}, ` +
          `extra ${JSON.stringify(extra)}`
      );
    } catch (e) {
      console.error(
        `refusing to start: ${e.message}\n` +
          `set OZ_API_KEY (https://channels.openzeppelin.com/testnet/gen), or run ` +
          `MOCK_PAYMENT=1 to exercise the proof lane alone.`
      );
      process.exit(1);
    }
  }
  server.listen(PORT, () => {
    console.log(
      RELATION_MODE
        ? `pq402 on http://localhost:${PORT} — FULL RELATION via ${RELATION_CONTRACT} ` +
            `(${NETWORK}, binding q=${RELATION_BINDING_Q} + membership q=40, root ${treeRoot.slice(0, 16)}…)` +
            (MOCK_PAYMENT ? " [payment MOCK]" : "")
        : `pq402 on http://localhost:${PORT} — verifier ${CONTRACT_ID} (${NETWORK}, q=${NUM_QUERIES})` +
            (MOCK_PAYMENT ? " [payment MOCK]" : "")
    );
  });
}
boot();
