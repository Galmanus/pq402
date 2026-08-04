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
  // Money reads as money: two decimals unless the amount genuinely needs more.
  // Stripping trailing zeros turned 0.10 into "$0.1", which is the sort of
  // thing that makes someone look twice at a price they should be able to
  // glance at. Sub-cent amounts keep their precision, up to Stellar's seven.
  const seven = usd.toFixed(7).replace(/0+$/, "");
  const decimals = Math.max(2, seven.split(".")[1]?.length ?? 0);
  return "$" + usd.toFixed(Math.min(decimals, 7));
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
  // v2 publishes the requirements in the `payment-required` header and only
  // echoes them in the body as a courtesy; v1 has the body alone. Prefer the
  // header, because a v2 server is under no obligation to fill the body.
  let doc = body;
  const encoded = getHeader("payment-required");
  if (encoded) {
    try {
      doc = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      /* fall back to the body */
    }
  }

  const acc = doc && Array.isArray(doc.accepts) ? doc.accepts[0] : {};
  const network = acc.network || getHeader("x-payment-network") || "stellar:testnet";

  // v2 calls it `amount`, v1 `maxAmountRequired`. Reading only the v1 name
  // against a v2 server leaves the price null — which printed as "?" and, far
  // worse, made the `--max` check fall through its own null guard. The cap
  // silently did not apply.
  const rawAmount = acc.amount ?? acc.maxAmountRequired ?? getHeader("x-payment-amount");

  // Stellar assets carry seven decimals. v2 dropped the `decimals` field
  // because the asset determines it.
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
