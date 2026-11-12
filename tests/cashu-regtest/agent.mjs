// An agent paying for a priced Archon API call with ecash (NUT-24). It registers a
// new DID through a paywalled Drawbridge:
//
//   1. POST the signed operation, and get HTTP 402 with a Cashu payment request;
//   2. ask its Keymaster what the request costs;
//   3. have Keymaster pay it from the agent's ecash, which returns a token;
//   4. POST again with the token in X-Cashu.
//
// The agent needs no Lightning node, channel or account, only ecash at the node's mint.
// Runs inside the cli container; see scenarios.py.
//
//   node agent.mjs <paywalled Drawbridge URL> <paying identity>
//
// ARCHON_KEYMASTER_URL and ARCHON_ADMIN_API_KEY name the Keymaster holding the ecash.

import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import KeymasterClient from '@didcid/clients/keymaster';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';

const [node, payer] = process.argv.slice(2);
if (!node || !payer) {
    console.error('usage: node agent.mjs <paywalled Drawbridge URL> <paying identity>');
    process.exit(2);
}

// The identity to register: a key of its own, in a wallet held in memory. Signing
// reads the registry's latest block, which the paywall serves free.
const gatekeeper = new GatekeeperClient();
await gatekeeper.connect({ url: node, waitUntilReady: true, intervalSeconds: 1, chatty: false });
const identity = new Keymaster({ gatekeeper, wallet: new WalletJsonMemory(), cipher: new CipherNode(), passphrase: 'agent' });
await identity.newWallet();
const operation = await identity.createIdOperation('agent', 0, { registry: 'local' });

const wallet = new KeymasterClient();
await wallet.connect({ url: process.env.ARCHON_KEYMASTER_URL, apiKey: process.env.ARCHON_ADMIN_API_KEY });
const payerDid = (await wallet.resolveDID(payer)).didDocument.id;

// X-DID only attributes the payment in the node's records. It proves nothing.
function register(headers = {}) {
    return fetch(`${node}/api/v1/did`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DID': payerDid, ...headers },
        body: JSON.stringify(operation),
    });
}

const unpaid = await register();
if (unpaid.status !== 402) {
    throw new Error(`expected HTTP 402 from an unpaid call, got ${unpaid.status}`);
}
const challenge = await unpaid.json();
const request = unpaid.headers.get('x-cashu');
if (!request) {
    throw new Error(`the node offers no Cashu payment, only: ${challenge.acceptedMethods}`);
}

const asked = await wallet.decodeCashuRequest(request, payer);
if (!asked.mint) {
    throw new Error(`${payer} has no ecash at a mint the node accepts: ${asked.mints}`);
}
const payment = await wallet.payCashuRequest(request, { max: asked.amount, name: payer });

const paid = await register({ 'X-Cashu': payment.token });
if (!paid.ok) {
    throw new Error(`the paid call failed with ${paid.status}: ${await paid.text()}`);
}

console.log(JSON.stringify({
    did: await paid.json(),
    payer: payerDid,
    acceptedMethods: challenge.acceptedMethods,
    request,
    asked,
    paid: { amount: payment.amount, fee: payment.fee, mint: payment.mint, operationId: payment.operationId },
    token: payment.token,
}));
