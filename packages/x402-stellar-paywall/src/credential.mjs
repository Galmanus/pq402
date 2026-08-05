// The other half of the gate: an anonymous credential, judged on-chain.
//
// A paywall answers "did they pay". Metered APIs usually have a second
// question — "are they allowed to buy this at all" — and the usual answers are
// an API key or an account, both of which make the caller identifiable across
// every request they ever make. This gate answers it without learning who is
// asking: the caller proves, in zero knowledge, that they hold a credential a
// registry issued, and the proof is judged by a Soroban contract that burns a
// per-challenge nullifier so the same proof cannot be used twice.
//
// What the server never learns: which credential. What it does learn: that one
// exists, is valid, and has not already been spent on this challenge. The
// verdict comes from consensus, not from this code — this module builds the
// challenge, shells the proof to the contract, and reads the answer.
//
//   const cred = credentialGate({ contract: "CA6QM6DR…", source: "my-key" });
//   res.set(cred.challengeHeaders(round));      // on the 402
//   const verdict = await cred.unlock(proof, publics);   // on POST /pq/unlock
//
// Requires the `stellar` CLI on PATH. A production proof is around 75 KB,
// which is 150 KB of hex — past Linux's 128 KB per-argument limit — so both
// arguments travel as files rather than as argv.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Mersenne-31: every limb of a public input must be a canonical field element. */
const P31 = (1 << 31) - 1;

/** Eight little-endian u64 limbs as hex, the shape the relation reads. */
export function leU64Hex(limbs) {
  const b = Buffer.alloc(limbs.length * 8);
  limbs.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), i * 8));
  return b.toString("hex");
}

/** A fresh single-use challenge: eight canonical M31 elements.
 *
 * Each limb reads a distinct 4-byte window of the 32 random bytes. The offset
 * is `i * 4`, not `(i * 4) % 28`: on a 32-byte buffer offset 28 reads bytes
 * 28..31 and is perfectly valid, whereas the modulo wrapped the eighth limb
 * back to offset 0 — making limb[7] a deterministic copy of limb[0] and the
 * challenge one limb shy of the entropy it claimed. */
export function freshRound() {
  const r = randomBytes(32);
  return Array.from({ length: 8 }, (_, i) => r.readUInt32LE(i * 4) % P31);
}

/**
 * A credential gate over one deployed verifier.
 *
 * `spend: true` (the default) submits a real transaction, so the nullifier
 * burns in contract storage and single use survives a restart of this process.
 * `spend: false` runs a read-only simulation — free, but then THIS server is
 * the replay authority, which is exactly the property the gate exists to move
 * onto the chain.
 */
export function credentialGate({
  contract,
  source,
  network = "testnet",
  queries = 40,
  action = "premium-api-access",
  spend = true,
  passTtlMs = 5 * 60_000,
} = {}) {
  if (!contract) throw new Error("credentialGate: contract is required (the deployed verifier)");
  if (!source) throw new Error("credentialGate: source is required (a stellar identity that can submit)");

  // A challenge is single-use and short-lived; a pass is single-use too. Both
  // are in memory on purpose: they are worthless to steal after one use, and
  // the durable half of the state — the burned nullifier — lives on-chain
  // where a restart cannot forget it.
  const challenges = new Map();
  const passes = new Map();

  const actionHex = leU64Hex(
    Array.from(action.padEnd(8, "\0")).slice(0, 8).map((c) => c.charCodeAt(0) % P31)
  );

  const sweep = () => {
    const cutoff = Date.now() - passTtlMs;
    for (const [k, v] of challenges) if (v < cutoff) challenges.delete(k);
    for (const [k, v] of passes) if (v.at < cutoff) passes.delete(k);
  };

  /** Headers to attach to a 402, describing what proof this route wants. */
  function challengeHeaders() {
    sweep();
    const roundHex = leU64Hex(freshRound());
    challenges.set(roundHex, Date.now());
    return {
      "x-pq-action": actionHex,
      "x-pq-challenge": roundHex,
      "x-pq-contract": contract,
      "x-pq-queries": String(queries),
    };
  }

  /** The same, as a body fragment, for clients that read JSON. */
  function requirement() {
    return { relation: "riverrun-binding-m31", contract, network, num_queries: queries };
  }

  /**
   * Judge a proof. Returns `{ ok: true, pass, tx }` or
   * `{ ok: false, status, error }` — never throws for a bad proof, because a
   * rejected credential is an ordinary answer and not an exception.
   */
  async function unlock(proofB64, publicsHex, { round } = {}) {
    if (typeof proofB64 !== "string" || typeof publicsHex !== "string")
      return { ok: false, status: 400, error: "proof_b64 and publics_hex are required" };

    // Where single use comes from depends on the mode. `spend` at 40 queries
    // burns the nullifier on-chain, so replay is refused by consensus whether
    // or not a round is supplied. `verify_q` burns nothing and this module
    // keeps no nullifier set, so the ONLY thing standing between it and an
    // infinitely replayable proof is the single-use round. Requiring it here
    // turns a silent replay hole into a refusal a caller can see and fix.
    const consuming = spend && queries === 40;
    if (!consuming && !round)
      return {
        ok: false,
        status: 400,
        error:
          "verify-only mode (spend:false or queries!=40) has no on-chain burn, " +
          "so unlock requires a single-use { round } to refuse replays",
      };
    if (round && !challenges.delete(round))
      return { ok: false, status: 403, error: "unknown or reused challenge round" };

    const dir = mkdtempSync(join(tmpdir(), "x402-cred-"));
    const proofPath = join(dir, "proof.bin");
    const publicsPath = join(dir, "publics.bin");
    writeFileSync(proofPath, Buffer.from(proofB64, "base64"));
    writeFileSync(publicsPath, Buffer.from(publicsHex, "hex"));

    // `spend` verifies at production security and burns; `verify_q` only
    // verifies. Burning is what makes single use a fact about the ledger
    // rather than a fact about this process. `consuming` was computed above,
    // where it also decides whether a single-use round is mandatory.
    const args = [
      "contract", "invoke", "--id", contract, "--source", source, "--network", network,
      ...(consuming ? ["--send=yes", "--", "spend"] : ["--", "verify_q"]),
      "--proof-file-path", proofPath, "--publics-file-path", publicsPath,
      ...(consuming ? [] : ["--num-queries", String(queries)]),
    ];

    const result = await new Promise((resolve) =>
      execFile("stellar", args, { maxBuffer: 1 << 22, timeout: 120_000 }, (err, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        if (err) return resolve({ err: err.message, stderr });
        resolve({
          ok: stdout.trim().split("\n").pop() === "true",
          tx: (stderr.match(/tx\/([0-9a-f]{64})/) || [])[1] || null,
        });
      })
    );

    if (result.err)
      return { ok: false, status: 502, error: `on-chain verify failed to run: ${result.err}` };
    if (!result.ok)
      return {
        ok: false,
        status: 403,
        error: consuming
          ? "the contract refused the spend: invalid proof, or this nullifier is already burned"
          : "the contract rejected the proof",
      };

    const pass = randomBytes(16).toString("hex");
    passes.set(pass, { at: Date.now() });
    return { ok: true, pass, tx: result.tx, mode: consuming ? "spend" : "verify_q" };
  }

  /**
   * Is this a live pass? Checking and consuming are separate on purpose.
   *
   * The x402 handshake sends the SAME request twice — once to be told the
   * price, once carrying the payment — so a gate that consumed the pass on
   * sight spent it on the first half and refused the second. The credential is
   * checked on both passes through, and consumed only once the request has
   * actually succeeded.
   */
  function hasPass(token) {
    sweep();
    return Boolean(token && passes.has(token));
  }

  /** Consume a pass. Single use: a second presentation finds nothing. */
  function usePass(token) {
    if (!hasPass(token)) return false;
    passes.delete(token);
    return true;
  }

  return { contract, network, queries, challengeHeaders, requirement, unlock, hasPass, usePass };
}
