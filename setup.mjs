// Generates the two testnet accounts pq402 needs, funds them with friendbot,
// and adds the USDC trustlines. The two steps this CANNOT do are the ones
// behind a captcha: the Circle USDC faucet and the OZ Channels key form.
//
//   node setup.mjs
//
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const friendbot = (a) => fetch(`https://friendbot.stellar.org?addr=${a}`);

async function trustline(kp) {
  const acc = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(60).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

const recipient = Keypair.random();
const payer = Keypair.random();
await Promise.all([friendbot(recipient.publicKey()), friendbot(payer.publicKey())]);
await new Promise(r => setTimeout(r, 3000));
await Promise.all([trustline(recipient), trustline(payer)]);
// Write the keys into .env rather than printing them and hoping. Four values
// copied by hand is four chances to paste a secret where a public key goes,
// and the resulting error names neither.
const envPath = new URL("./.env", import.meta.url);
let env = "";
try {
  env = await fs.readFile(envPath, "utf8");
} catch {
  env = await fs.readFile(new URL("./.env.example", import.meta.url), "utf8");
}
const put = (k, v) =>
  (env = env.match(new RegExp(`^${k}=.*$`, "m"))
    ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`)
    : `${env.trimEnd()}\n${k}=${v}\n`);
put("STELLAR_RECIPIENT", recipient.publicKey());
put("STELLAR_SECRET_KEY", payer.secret());

// Register the payer as a NAMED stellar identity. The agent CLI resolves its
// signing key through `stellar keys secret <name>`, and the server submits the
// credential spend the same way, so without this the last two steps fail on a
// key that exists but has no name.
const IDENTITY = process.env.PQ_IDENTITY || "pq402-payer";
try {
  execFileSync("stellar", ["keys", "add", IDENTITY, "--secret-key", "--overwrite"], {
    input: payer.secret() + "\n",
    stdio: ["pipe", "ignore", "ignore"],
  });
  put("PQ_SOURCE", IDENTITY);
  console.log(`registered the payer as stellar identity "${IDENTITY}"`);
} catch {
  console.log(
    `could not run \`stellar keys add ${IDENTITY}\` — install the Stellar CLI, ` +
      `then: echo ${payer.secret()} | stellar keys add ${IDENTITY} --secret-key`
  );
}
await fs.writeFile(envPath, env);
console.log("\nwrote STELLAR_RECIPIENT and STELLAR_SECRET_KEY into .env");

console.log("\nFund the payer with USDC:  https://faucet.circle.com  (Stellar testnet)");
console.log("Get a facilitator key:     https://channels.openzeppelin.com/testnet/gen\n");
console.log(JSON.stringify({
  recipient_public: recipient.publicKey(),
  recipient_secret: recipient.secret(),
  payer_public: payer.publicKey(),
  payer_secret: payer.secret(),
}, null, 2));
