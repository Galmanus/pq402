// The unlinkable credential gate.
//
// `credentialGate` in credential.mjs answers "does this caller hold a valid
// credential" without learning the secret. It still learns the LEAF, because
// the leaf is a public input of that relation — so the server knows *which*
// credential paid, and two payments by the same credential are trivially
// linked to each other.
//
// This gate closes that. The relation publishes
//
//     C = compress(leaf ‖ blinder)
//
// with a fresh blinder each use, and never the leaf. Two halves, composed by
// that shared C:
//
//   * the acting half proves a valid credential acted under C, and burns a
//     nullifier so the same proof cannot be spent twice;
//   * the membership half proves C sits under the issuer's published root, via
//     a private authentication path.
//
// What the server learns: someone in the issuer's set paid. Not who. And two
// payments by one credential share no public value at all, because the blinder
// is fresh — so they cannot be linked to each other either.
//
// The round is not the server's to choose. `act` derives the expected round
// from the ledger sequence and refuses anything else, which means the
// challenge comes from consensus rather than from whoever is asking.
//
//   const gate = crowdGate({
//     actContract: "CAEZ25KZ…",       // verifies the acting half AND burns
//     membershipContract: "CDO2NDPR…", // verifies membership under a root
//     root: "<64 bytes hex>",          // the issuer's published root
//     source: "my-key",
//   });
//
// Requires the `stellar` CLI on PATH.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** crowd binding publics: action[8] ‖ round[8] ‖ C[8] ‖ nullifier[8]. */
const C_OFFSET = 16 * 8;
const C_BYTES = 8 * 8;

const run = (args, timeout = 180_000) =>
  new Promise((resolve) =>
    execFile("stellar", args, { maxBuffer: 1 << 22, timeout }, (err, stdout, stderr) =>
      err
        ? resolve({ err: err.message, stderr })
        : resolve({ out: stdout.trim().split("\n").pop(), tx: (stderr.match(/tx\/([0-9a-f]{64})/) || [])[1] || null })
    )
  );

export function crowdGate({
  actContract,
  membershipContract,
  root,
  source,
  network = "testnet",
  queries = 12,
  logBlowup = 7,
  passTtlMs = 5 * 60_000,
} = {}) {
  if (!actContract) throw new Error("crowdGate: actContract is required");
  if (!membershipContract) throw new Error("crowdGate: membershipContract is required");
  if (!root) throw new Error("crowdGate: root is required (the issuer's published Merkle root)");
  if (!source) throw new Error("crowdGate: source is required (a stellar identity that can submit)");

  const passes = new Map();
  const sweep = () => {
    const cutoff = Date.now() - passTtlMs;
    for (const [k, v] of passes) if (v < cutoff) passes.delete(k);
  };

  /** The round the chain expects. Not ours to pick, and not the caller's. */
  async function currentRound() {
    const r = await run([
      "contract", "invoke", "--id", actContract, "--source", source,
      "--network", network, "--", "current_round",
    ]);
    if (r.err) throw new Error(`could not read the current round: ${r.err}`);
    return (r.out || "").replace(/"/g, "");
  }

  /** What a client needs to build a proof this gate will accept. */
  async function requirement() {
    return {
      relation: "riverrun-crowd-m31",
      act_contract: actContract,
      membership_contract: membershipContract,
      root,
      network,
      num_queries: queries,
      log_blowup: logBlowup,
      round: await currentRound(),
      unlock: "POST /pq/unlock",
      note: "the round comes from the ledger, not from this server",
    };
  }

  function tmp(files) {
    const dir = mkdtempSync(join(tmpdir(), "x402-crowd-"));
    const paths = {};
    for (const [name, { data, encoding }] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], Buffer.from(data, encoding));
    }
    return { dir, paths };
  }

  /**
   * Judge both halves. Returns `{ ok: true, pass, tx, commitment }` or
   * `{ ok: false, status, error }`.
   */
  async function unlock({
    binding_proof_b64,
    binding_publics_hex,
    membership_proof_b64,
    membership_publics_hex,
  } = {}) {
    for (const [k, v] of Object.entries({
      binding_proof_b64, binding_publics_hex, membership_proof_b64, membership_publics_hex,
    })) {
      if (typeof v !== "string") return { ok: false, status: 400, error: `${k} is required` };
    }

    // Compose on C before spending anything. The two proofs are only about the
    // same credential if they share it, and checking that costs nothing while
    // the STARKs cost two transactions.
    const bp = Buffer.from(binding_publics_hex, "hex");
    const mp = Buffer.from(membership_publics_hex, "hex");
    const cBinding = bp.subarray(C_OFFSET, C_OFFSET + C_BYTES).toString("hex");
    const cMembership = mp.subarray(0, C_BYTES).toString("hex");
    if (!cBinding || cBinding !== cMembership)
      return { ok: false, status: 403, error: "the two proofs are about different commitments" };

    // And the membership must be against OUR root, not one the prover chose.
    // A membership proof is only ever a statement about the tree the prover
    // picked; without this check anyone can build a tree containing their own
    // leaf and prove membership in it.
    const claimedRoot = mp.subarray(C_BYTES).toString("hex");
    if (claimedRoot !== root.toLowerCase())
      return { ok: false, status: 403, error: "membership proved against a different root" };

    const { dir, paths } = tmp({
      "binding.bin": { data: binding_proof_b64, encoding: "base64" },
      "binding_publics.bin": { data: binding_publics_hex, encoding: "hex" },
      "membership.bin": { data: membership_proof_b64, encoding: "base64" },
      "membership_publics.bin": { data: membership_publics_hex, encoding: "hex" },
    });

    try {
      // Membership first, read-only and free: no point burning a nullifier for
      // a caller who is not in the set.
      const m = await run([
        "contract", "invoke", "--id", membershipContract, "--source", source,
        "--network", network, "--", "verify_crowd_membership",
        "--proof-file-path", paths["membership.bin"],
        "--publics-file-path", paths["membership_publics.bin"],
        "--num_queries", String(queries), "--log_blowup", String(logBlowup),
      ]);
      if (m.err) return { ok: false, status: 502, error: `membership check failed to run: ${m.err}` };
      if (m.out !== "true")
        return { ok: false, status: 403, error: "the commitment is not under the issuer's root" };

      // Then the acting half, which costs a transaction and burns.
      const a = await run([
        "contract", "invoke", "--send=yes", "--id", actContract, "--source", source,
        "--network", network, "--", "act",
        "--proof-file-path", paths["binding.bin"],
        "--publics-file-path", paths["binding_publics.bin"],
        "--num_queries", String(queries), "--log_blowup", String(logBlowup),
      ]);
      if (a.err) return { ok: false, status: 502, error: `spend failed to run: ${a.err}` };
      if (a.out !== "true")
        return {
          ok: false,
          status: 403,
          error:
            "the contract refused: an invalid proof, a stale round, or this nullifier is already burned",
        };

      const pass = randomBytes(16).toString("hex");
      passes.set(pass, Date.now());
      return { ok: true, pass, tx: a.tx, commitment: cBinding };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function hasPass(token) {
    sweep();
    return Boolean(token && passes.has(token));
  }
  function usePass(token) {
    if (!hasPass(token)) return false;
    passes.delete(token);
    return true;
  }

  return {
    kind: "crowd",
    contract: actContract,
    membershipContract,
    root,
    network,
    queries,
    logBlowup,
    currentRound,
    requirement,
    unlock,
    hasPass,
    usePass,
  };
}
