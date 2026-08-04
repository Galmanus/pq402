// Pure helpers for stellar-agent-pay, split out so they can be tested without
// a network or the stellar CLI.

export function parseArgs(argv) {
  const o = { network: null, source: null, max: null, yes: false, quiet: false, pqSecret: null, pqProver: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--source") o.source = argv[++i];
    else if (a === "--network") o.network = argv[++i];
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--pq-secret") o.pqSecret = argv[++i];
    else if (a === "--pq-prover") o.pqProver = argv[++i];
    else rest.push(a);
  }
  o.url = rest[0];
  return o;
}

// A clean decimal for display — never scientific notation, trailing zeros trimmed.
export function money(usd) {
  if (usd == null) return "?";
  return "$" + usd.toFixed(7).replace(/\.?0+$/, "");
}

// CAIP-2 network id the x402 stellar client expects.
export function caip2(network) {
  return network === "pubnet" || network === "stellar:pubnet"
    ? "stellar:pubnet"
    : "stellar:testnet";
}

// Extract a post-quantum credential challenge from a 402, if the server sent
// one. Returns null when the endpoint is not PQ-gated. Pure: header lookup in,
// object out. Hex fields are 64 bytes (8 LE u64s, M31-reduced) each.
export function parsePqChallenge(getHeader = () => null) {
  const challenge = getHeader("x-pq-challenge");
  const action = getHeader("x-pq-action");
  if (!challenge || !action) return null;
  if (!/^[0-9a-f]{128}$/.test(challenge) || !/^[0-9a-f]{128}$/.test(action)) return null;
  return {
    challenge,
    action,
    contract: getHeader("x-pq-contract") || null,
    queries: Number(getHeader("x-pq-queries") || 26),
    // "relation" upgrades the proof to binding + membership under the
    // issuer's Merkle root (sent as x-pq-root), composed on-chain.
    mode: getHeader("x-pq-mode") || "leaf",
    root: getHeader("x-pq-root") || null,
  };
}

// Extract payment requirements from a parsed 402 body and a header lookup.
// `getHeader(name)` returns a header value or null. Pure: no fetch, no Response.
export function parseRequirements(body, getHeader = () => null) {
  const acc = body && Array.isArray(body.accepts) ? body.accepts[0] : {};
  const network = acc.network || getHeader("x-payment-network") || "stellar:testnet";
  const rawAmount = acc.maxAmountRequired ?? getHeader("x-payment-amount");
  const decimals = Number(acc.decimals ?? 7);
  const usd = rawAmount != null ? Number(rawAmount) / 10 ** decimals : null;
  return {
    network,
    payTo: acc.payTo || getHeader("x-payment-payto") || null,
    asset: acc.asset || "USDC",
    usd,
    raw: rawAmount,
  };
}
