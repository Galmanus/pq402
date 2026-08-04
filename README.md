# pq402

**An x402 paid API on Stellar whose unlock also requires a post-quantum
credential — and a CLI agent that completes the whole loop from the terminal.**

Stellar Summit SP 2026 · Payments and Agent Tooling (SDF DevEx) ·
sub-lane 3A, Agentic Payments (x402 / MPP)

```
$ stellar agent-pay http://localhost:4402/premium --max 0.10
→ GET http://localhost:4402/premium
← 402 Payment Required: 0.10 USDC on stellar:testnet → GAWAG7OD…
proving PQ credential (q=40, contract CD72SHMV…)…
proof: 79227 bytes in 12ms
PQ verified ON-CHAIN by CD72SHMV… (testnet) → pass granted
nullifier burned by consensus: …/tx/ddc77ecb804691aac7f84a13dfbe24f84d87e90fb…
paying…
← 200 unlocked        settlement f8c8fb36379f83ce9fbb11756c5d1bf9efe5b38bde…
```

Both hashes are real and on testnet. [`TRANSCRIPT.md`](TRANSCRIPT.md) has the
full run, including the balances moving `20.0 → 19.9` and `0 → 0.10` USDC, and
the network fee being paid by the **facilitator** rather than the agent.

## What this is

Most agent-payment demos answer one question: *did the agent pay?* This one
answers a second that metered APIs actually have: *is this agent allowed to buy
this at all?* — and answers it without learning who the agent is.

Two independent gates on one request:

| gate | mechanism | who decides |
|---|---|---|
| **payment** | x402 `exact` scheme, USDC over its Soroban Asset Contract, settled through the OpenZeppelin Channels facilitator | Stellar consensus |
| **credential** | a hash-based STARK proving the caller holds a valid credential, verified by a Soroban contract, nullifier burned in contract storage | Stellar consensus |

Neither gate trusts the server. The paywall cannot forge a settlement, and it
cannot decide the credential is valid — it forwards a proof to a deployed
contract and reads the verdict. Replay is refused by the chain rather than by
an in-process set, so restarting the server does not reopen a spent credential.

## Run it

```bash
git clone https://github.com/Galmanus/pq402 && cd pq402
cp .env.example .env      # then fill in, see below
node server.mjs           # terminal 1
./demo.sh                 # terminal 2
```

Four things go in `.env`:

1. **An OZ Channels testnet key.** A plain GET mints one:
   ```bash
   curl -s https://channels.openzeppelin.com/testnet/gen
   # {"apiKey":"…"}
   ```
   Required on testnet as well as mainnet; every facilitator endpoint answers
   `401` without it, and this server refuses to start rather than advertise a
   paywall it cannot settle.
2. **Testnet USDC for the payer** — [faucet.circle.com](https://faucet.circle.com),
   pick Stellar testnet. This one is captcha-gated and has to be done by hand.
3. A recipient `G...` account with a USDC trustline (`STELLAR_RECIPIENT`).
4. The payer's `S...` secret, with a USDC trustline (`STELLAR_SECRET_KEY`).

`setup.mjs` does the parts that can be automated — it generates both keypairs,
friendbots them, and adds the trustlines:

```bash
node setup.mjs
```

To try the credential half with no key and no funded wallet, set
`MOCK_PAYMENT=1`. That stubs **only** the settlement; the proof still goes to
the chain and the nullifier still burns.

## The flow

```
agent → GET /premium
     ← 402  { accepts: [ exact, USDC SAC, amount, payTo ],
              pq_required: { contract, relation, challenge } }

agent   proves the credential locally           ~12 ms
agent → POST /pq/unlock  { proof, publics }
server→ Soroban: spend(proof, publics)          verify + burn, one tx
     ← { pass, burn_tx }                        the chain decided

agent → GET /premium  + PAYMENT-SIGNATURE + X-PQ-PASS
server→ facilitator /verify   then   /settle    USDC moves on Stellar
     ← 200 + the goods + settlement tx hash
```

Verify precedes settle deliberately: settle moves money, so a payload that
fails verification must never reach it. A refusal returns the facilitator's own
reason rather than a bare `402`.

Four details worth stealing if you build your own — each one cost a debugging
round here:

- **`asset` is the SAC (`C…`), `payTo` is the classic account (`G…`).** The
  scheme invokes `transfer` on the contract; the account is what ends up
  holding the balance, which is also why it needs a trustline.
- **Stellar USDC has seven decimals, not six.** `0.10` is `1000000` base units.
  The EVM habit is a 10× underpayment that settles quietly.
- **v2 puts the requirements in a `payment-required` HEADER, not the body.** The
  body is read only when `x402Version === 1`. A server that publishes perfect
  requirements in JSON alone is invisible to a v2 client, which fails with
  `Invalid payment required response` having never looked at them. Every 402 on
  a gated route needs the header, including the one that says "you have a pass
  but no payment yet".
- **The signed payload comes back in `PAYMENT-SIGNATURE`**, with `X-PAYMENT`
  being the v1 name. Read both.
- **`extra.areFeesSponsored` must be in the requirements**, and it belongs to
  the facilitator. Ask `/supported` at startup and copy what it says rather
  than asserting it yourself.

## Why x402 here

x402 lets the agent hold **zero XLM**. It signs Soroban authorization entries
rather than transaction envelopes; the facilitator assembles the transaction,
pays the fee, and submits. For an autonomous agent that is the difference
between maintaining a funded gas wallet and holding only the asset it intends
to spend.

MPP Charge is the better pick when you would rather not depend on a facilitator
at all — it settles directly through the SAC. The two are complementary; this
repo takes the x402 path because fee sponsorship is what keeps an agent's
wallet simple.

## Layout

```
server.mjs   the paywall: 402, the PQ challenge, verify-then-settle
booth.mjs    the same flow driven from a browser, for demoing on a screen
demo.sh      one command, end to end
setup.mjs    generates and funds the two testnet accounts
bin/         prover binaries, built from the riverrun-m31 Rust crate
cli/         `stellar agent-pay`, the plugin the agent runs
ui/          the booth's page
```

### The CLI plugin

`cli/` installs as an external `stellar` subcommand, so it composes with the
keys you already manage:

```bash
cd cli && ./install.sh
stellar agent-pay <url> --max 0.10 --source my-key
```

It prints the price before paying, enforces `--max`, refuses to spend in a pipe
without `--yes`, and returns a distinct exit code for each way it can refuse —
so a script can tell "too expensive" from "credential rejected" from
"settlement failed" without parsing prose.

## Honest limits

This section exists because a payments demo that overstates is worth less than
one that under-delivers.

- **The proof lane is never mocked.** The verdict comes from a deployed
  contract and the nullifier burn is a real transaction with an explorer link.
  `MOCK_PAYMENT=1` stubs the settlement only, and when it is on the 402 says so
  in its own body.
- **Post-quantum describes the proof system, not Stellar.** The STARK is
  hash-based and survives Shor. The transaction carrying it is signed with
  Ed25519, which does not. This is a post-quantum component running on a
  pre-quantum chain, and the other half is the network's to supply.
- **The credential relation publishes digests, and that took a fix.** Until
  04/08 it published the full sixteen-limb permutation state for both the leaf
  and the nullifier. Poseidon2 is a bijection and the context sits public
  beside it, so one inversion on published data returned the credential secret
  — demonstrated against a real testnet proof, in milliseconds. Both are now
  truncated to eight limbs, which puts recovery back at `|F|^8 ≈ 2^248`, and
  the verifier here (`CA6QM6DR…`) is built from the repaired relation. The
  provers in `bin/` were rebuilt with it; a mismatched pair fails loudly on the
  public-input length rather than silently.
- **Single use survives a restart, not a redeploy.** The nullifier lives in
  contract storage, so the server can restart freely. Deploying a fresh
  verifier starts a fresh nullifier set.

## Built on

- [x402](https://github.com/coinbase/x402) — `@x402/fetch`, `@x402/stellar`
- [OpenZeppelin Channels](https://channels.openzeppelin.com) as the facilitator
- [Plonky3](https://github.com/Plonky3/Plonky3) for the Circle STARK machinery
- The credential relation and its Soroban verifier come from riverrun

MIT.
