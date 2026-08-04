# stellar agent-pay

A Stellar CLI plugin that pays an x402/402-gated URL from the terminal or a script. `stellar agent-pay <url>` completes the **402 → pay → unlock** loop, so any agent or shell workflow can settle a paywall — signing with a key that already lives in your `stellar keys` store. When the endpoint also demands a credential, the plugin proves it with a **post-quantum STARK verified on-chain** (see below), still in one command.

```console
$ stellar agent-pay https://api.example.com/report --max 0.10 --yes
→ GET https://api.example.com/report
← 402 Payment Required: $0.01 USDC on stellar:pubnet → GABC1234…
paying…
← 200 unlocked
{"report": "…"}
```

## Why

x402 turns any HTTP endpoint into a metered service an agent can pay for. But paying one means wiring up a signer, building the auth entries, talking to a facilitator. This plugin is that, as one command — and it borrows the identity you already manage with the Stellar CLI, so there is no second wallet and no key pasted into a script.

It is a real external subcommand: the `stellar` CLI dispatches `stellar agent-pay …` to the `stellar-agent-pay` binary on your PATH, the same way `git` finds `git-<x>`. Install it once and it is part of your `stellar` toolbelt.

## Install

```bash
npm install -g stellar-agent-pay
# or, from a clone:
./install.sh
```

Requires Node 18+ and the `stellar` CLI on your PATH. Verify:

```bash
stellar agent-pay --help
```

## Use

```
stellar agent-pay <url> [OPTIONS]

  --source <name>    stellar keys identity to pay from (default: $STELLAR_ACCOUNT or "default")
  --network <net>    testnet | pubnet (default: taken from the 402 response)
  --max <usd>        refuse to pay more than this, e.g. --max 0.10
  --yes              pay without prompting (required in non-interactive/script use)
  --quiet            print only the unlocked body (for piping)
  --pq-secret <hex>  post-quantum credential secret (or @file), see below
  --pq-prover <bin>  path to the prove_action binary (default: $PQ_PROVER)
  -h, --help
```

The flow:

1. It GETs the URL unpaid. If the server does not ask for payment, you just get the body — no key touched, nothing spent.
2. On a `402`, it reads the payment requirements and shows you the amount, asset, network, and recipient **before** any money moves.
3. `--max` is enforced at that point. Over the cap it refuses with exit code
   `3` and never signs; inside the cap but unconfirmed in a pipe it refuses
   with `6`. Two codes, because a script should stop and alert on the first and
   simply re-run with `--yes` on the second.
4. In a script (no TTY), it refuses unless `--yes` is given — a bare pipe cannot silently spend.
5. Otherwise it reads the secret from `stellar keys secret <source>`, signs the Soroban auth entries, the facilitator settles, and you get the unlocked body on stdout.

Because the client signs auth entries (not full transactions) and the facilitator sponsors fees, the paying identity needs USDC but **no XLM**.

### In a script

```bash
# fetch a paid data feed, capped, quiet, into a file
stellar agent-pay https://api.example.com/ticks --max 0.05 --yes --quiet --source bot > ticks.json
```

Exit codes: `0` unlocked (paid or free) · `2` usage · `3` refused (over `--max`, or no `--yes`) · `4` payment/settlement failed · `5` PQ credential missing or refused.

## Post-quantum credential gate

Some endpoints demand more than money: proof that the caller holds an
authorized credential, without a login and without an API key to leak. When a
402 carries a PQ challenge (`x-pq-challenge` / `x-pq-action` headers), the
plugin proves it in place with a hash-based STARK (riverrun's binding
relation: post-quantum, no trusted setup) and trades the proof for a
single-use pass before paying:

```console
$ stellar agent-pay http://localhost:4402/premium --pq-secret @cred.hex --yes
→ GET http://localhost:4402/premium
← 402 Payment Required: $0.1 USDC on stellar:testnet → GA4VTIGQ…
proving PQ credential (q=40, contract CA6QM6DR…)…
proof: 77253 bytes in 21ms
PQ verified ON-CHAIN by CA6QM6DR… (testnet, 9179ms) → pass granted
nullifier burned by consensus: https://stellar.expert/explorer/testnet/tx/53a65c74…
paying… [MOCK lane, server-declared]
← 200 unlocked
```

The verdict comes from a deployed Soroban contract, not from the server: the
contract verifies the STARK at production security AND burns the proof's
nullifier in its own storage, in one transaction. Replaying the same
credential proof is refused by the chain itself, and proving takes
milliseconds.

**What this does not do yet, stated plainly:** the underlying commitment is
not hiding, so a published proof leaks its own witness, credential secret
included, to anyone who reads the transaction. Treat these credentials as
demonstration material, not as secrets. The measurement, the cause and the
cost of fixing it are in
[riverrun-soroban/docs/PRIVACY.md](https://github.com/Galmanus/riverrun-soroban/blob/master/docs/PRIVACY.md).

The counterpart server and the verifier contract live in
[riverrun-soroban](https://github.com/Galmanus/riverrun-soroban) (see
`demo/pq402`); the prover binary is `prove_action` from
[mirror-pool](https://github.com/Galmanus/mirror-pool)'s riverrun-m31 crate.

## Scope

This is a v2 x402 client (Soroban auth-entry / `exact` scheme), the current Stellar x402 standard. It negotiates USDC by default; the amount and asset come from the server's 402. It does not implement the older v1 (classic USDC + memo) scheme — pointed at a v1 endpoint it will report the version mismatch rather than pay incorrectly.

## Verification

Tested against a live 402 endpoint end to end: it parses the requirements, displays the amount, enforces `--max`, reads the key from the stellar keystore, and drives the x402 payment path. See [`test/`](test) for the unit tests over argument parsing, amount formatting, and requirement parsing.

## License

MIT.
