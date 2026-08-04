// Generates the two testnet accounts pq402 needs, funds them with friendbot,
// and adds the USDC trustlines. The two steps this CANNOT do are the ones
// behind a captcha: the Circle USDC faucet and the OZ Channels key form.
//
//   node setup.mjs
//
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
console.log("\nFund the payer with USDC:  https://faucet.circle.com  (Stellar testnet)");
console.log("Get a facilitator key:     https://channels.openzeppelin.com/testnet/gen\n");
console.log(JSON.stringify({
  recipient_public: recipient.publicKey(),
  recipient_secret: recipient.secret(),
  payer_public: payer.publicKey(),
  payer_secret: payer.secret(),
}, null, 2));
